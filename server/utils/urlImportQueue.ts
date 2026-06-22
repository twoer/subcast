/* SPDX-License-Identifier: Apache-2.0 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile as writeFileAsync, readdir } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { YT_DLP_PATH } from './ytDlpPaths';
import { getDb, SUBCAST_PATHS } from './db';
import { generateWaveform } from './waveform';
import { logEvent } from './log';

/**
 * Hard size cap for URL imports. Mirrors the local upload limit
 * (server/api/upload.post.ts MAX_BYTES) so a user can't bypass the 2GB
 * ceiling by pasting a URL instead of selecting a file. Applied both as
 * yt-dlp's --max-filesize and as a post-download stat() re-check on the
 * merged file.
 */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Extensions we accept as a final import. Anything else (unknown sidecar,
 * temp .part, yt-dlp metadata) is rejected. Lowercased, leading dot kept,
 * matching the shape stored in `videos.ext` and consumed by /api/video's
 * MIME map.
 */
const ALLOWED_MEDIA_EXTS = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'];

/** Coerce a raw extension to a known media ext, defaulting to '.mp4'. */
function normalizeMediaExt(raw: string): string {
  const ext = raw.toLowerCase();
  return ALLOWED_MEDIA_EXTS.includes(ext) ? ext : '.mp4';
}

/**
 * Build a display name for the `videos.original_name` column from the source
 * URL + the resolved media extension. Strips a trailing media extension from
 * the URL's last path segment first, so `https://x/v/video.mp3` + `.mp3`
 * yields `video.mp3` (not `video.mp3.mp3`). Non-media suffixes are left
 * intact so query-style slugs still read naturally.
 */
export function buildOriginalName(url: string, ext: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? 'video';
    const stripped = last.replace(/\.(mp4|mkv|mov|webm|mp3|wav|m4a)$/i, '');
    return `${stripped}${ext}`;
  } catch {
    return `url-import${ext}`;
  }
}

/**
 * Extract a one-line human-readable error message from yt-dlp's combined
 * stderr. yt-dlp's failure output usually looks like one of:
 *
 *   Usage: yt-dlp [OPTIONS] URL [URL...]
 *   yt-dlp: error: invalid http retry sleep expression '5,exponential'
 *
 *   ERROR: [download] ... HTTP Error 503 ...
 *
 * The old code joined the last 6 lines, which for argv errors captured the
 * whole "Usage:" banner verbatim and made diagnostics/log banners unreadable
 * ("Usage: yt-dlp [OPTIONS] URL [URL...] yt-dlp: error: ..."). Prefer the
 * explicit `yt-dlp: error:` / `ERROR:` / `error:` markers; fall back to the
 * last non-empty line that isn't part of the usage banner.
 */
export function extractYtDlpError(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  // Iterate from the end so we find the terminal error first. lines[i] is
  // typed `string | undefined` under noUncheckedIndexedAccess, so skip gaps.
  // 1. Explicit error markers — yt-dlp uses these for actionable failures.
  //    `yt-dlp: error:` is the argparse form; `ERROR:` is the runtime form;
  //    lowercase `error:` covers some extractors. Take the LAST occurrence
  //    (a download attempt can emit several, the last is the terminal one).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/^(?:yt-dlp:\s*error:\s*|ERROR:\s*|error:\s*)(.*)$/i);
    if (m) {
      const rest = (m[1] ?? '').trim();
      // Keep the marker prefix so users recognise it as a yt-dlp error and
      // not our own message, but drop redundant whitespace.
      const prefix = line.match(/^(yt-dlp:\s*error:|ERROR:|error:)/i)?.[1] ?? '';
      return `${prefix} ${rest}`.trim();
    }
  }
  // 2. Fall back to the last non-Usage, non-empty line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith('Usage:') || line.startsWith('usage:')) continue;
    return line;
  }
  // Unreachable for a non-empty input with at least one non-Usage line, but
  // satisfy the return type under noUncheckedIndexedAccess.
  return '';
}

/**
 * URL-import queue. Mirrors the transcribeQueue shape (single in-flight
 * task, attach() returns an async iterator of progress frames, SSE
 * endpoints subscribe to it) but is much simpler: one yt-dlp process at
 * a time, no resume, no chunking.
 *
 * Flow:
 *   1. ensureTask(url)  -> creates a task row, returns it
 *   2. tryStartNext()   -> spawns yt-dlp with --progress-template
 *   3. attach(taskId)   -> async iterator yielding progress frames
 *   4. on exit: stream-hash the downloaded file, rename to videos/<sha>.mp4,
 *      upsert the `videos` row, fan-out a done frame with {hash}
 *
 * Progress comes from yt-dlp's `--progress-template` which emits one
 * structured line per progress tick — far more robust than parsing the
 * default `[download] xx.x% of ~MiB` human-readable bars (which yt-dlp
 * redraws with carriage returns under --newline and is regex-fragile).
 */

export type UrlImportPhase = 'queued' | 'fetching_info' | 'downloading' | 'finalizing' | 'done' | 'error' | 'canceled';

export interface UrlImportProgressFrame {
  phase: UrlImportPhase;
  /** 0..1 download progress (undefined before yt-dlp reports total size). */
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  /** Human-readable speed string from yt-dlp (e.g. "3.85MiB/s"). */
  speed?: string;
  eta?: number;
  /** Set on the terminal frame: the content sha so the client navigates. */
  hash?: string;
  error?: string;
  id?: number;
}

export interface UrlImportTask {
  id: string;
  url: string;
  phase: UrlImportPhase;
  /** Output path of the downloaded file (filled in once download starts). */
  outputPath: string | null;
  ext: string;
  originalName: string | null;
  /** Last progress snapshot for late SSE attachers (history replay). */
  lastFrame: UrlImportProgressFrame | null;
  createdAt: number;
}

/** Parse one `--progress-template "PROGRESS ..."` line into a frame. */
export function parseProgressLine(line: string): UrlImportProgressFrame | null {
  // Our template: "PROGRESS %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s"
  // yt-dlp may also emit a pre-download "downloading" event and a final
  // 100% line; we parse what we can.
  if (!line.includes('PROGRESS')) return null;
  // yt-dlp's --progress-template emits lines shaped like:
  //   "PROGRESS  53.6% of    7.46MiB at    3.85MiB/s ETA 00:00"
  // but the opening ticks (before the first bytes arrive) report:
  //   "PROGRESS   0.0% of    7.46MiB at  Unknown B/s ETA Unknown"
  // and the final tick reports:
  //   "PROGRESS 100.0% of    7.46MiB at 1.55MiB/s ETA NA"
  // The percent + total fields are always numeric; speed/eta can be
  // "Unknown"/"NA". Match percent+total strictly (they're what the UI
  // needs), then opportunistically grab speed/eta when they're present
  // and not the "Unknown" placeholder.
  const m = line.match(/PROGRESS\s+([\d.]+)%\s+of\s+([\d.]+\w+)/);
  if (!m) return null;
  const pctStr = m[1]!;
  const totalStr = m[2]!;
  const percent = Math.max(0, Math.min(1, Number(pctStr) / 100));
  const bytesTotal = humanSizeToBytes(totalStr);
  const bytesDone = bytesTotal != null ? Math.round(bytesTotal * percent) : undefined;
  // Speed / ETA are best-effort: extract only when yt-dlp has real values
  // (not "Unknown"). Falling back to undefined keeps the UI honest.
  let speed: string | undefined;
  let eta: number | undefined;
  const speedM = line.match(/at\s+([\d.]+\S+\/s)\s+ETA/);
  if (speedM) speed = speedM[1]!.trim();
  const etaM = line.match(/ETA\s+(\S+)/);
  if (etaM && etaM[1] !== 'NA' && etaM[1] !== 'Unknown') {
    eta = parseEta(etaM[1]!);
  }
  return {
    phase: 'downloading',
    percent,
    bytesDone,
    bytesTotal,
    speed,
    eta,
  };
}

/** Convert "7.46MiB" / "103.12KiB" / "2.60MiB" to byte count. Returns null on miss. */
export function humanSizeToBytes(s: string): number | undefined {
  const m = s.match(/^([\d.]+)\s*(KiB|MiB|GiB|TiB|B)$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2]!.toLowerCase();
  const mult: Record<string, number> = {
    b: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  return Math.round(n * (mult[unit] ?? 1));
}

/** Convert "00:08" or "03:40" to seconds. Returns undefined on "NA" / unparseable. */
export function parseEta(s: string): number | undefined {
  if (s === 'NA') return undefined;
  const m = s.match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) {
    const secs = Number(s);
    return Number.isFinite(secs) ? secs : undefined;
  }
  const [, h, mm, ss] = m;
  return (Number(h ?? '0') * 60 + Number(mm)) * 60 + Number(ss);
}

/**
 * Derive a reasonable extension + filename from a URL. yt-dlp gives us
 * the real extension only after the info-json stage, so this is a
 * best-effort pre-flight guess; the queue overrides it from yt-dlp's
 * `[download] Destination: <path>` line at runtime.
 */
export function guessExtFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.(mp4|mkv|mov|webm|mp3|wav|m4a)$/i);
    return m ? `.${m[1]!.toLowerCase()}` : '.mp4';
  } catch {
    return '.mp4';
  }
}

class UrlImportQueue {
  private tasks = new Map<string, UrlImportTask>();
  /** Listeners per task id. Each listener receives frames as they arrive. */
  private listeners = new Map<string, Set<(frame: UrlImportProgressFrame) => void>>();
  /**
   * The currently occupied execution slot. The slot is reserved
   * synchronously by tryStartNext() *before* any await, with proc = null;
   * runTask() attaches the spawned ChildProcess once yt-dlp is launched.
   * This closes the race where two concurrent ensureTask() calls both
   * observed current === null and both spawned yt-dlp.
   */
  private current: { task: UrlImportTask; proc: ChildProcess | null } | null = null;
  private queue: string[] = [];
  private jobCounter = 0;

  /** Create (or reuse) a task for a URL. Returns the task id. */
  ensureTask(url: string): UrlImportTask {
    // Dedup 1: if there's already an active/queued task for this exact
    // URL, return it. (Concurrent duplicate paste.)
    for (const task of this.tasks.values()) {
      if (task.url === url && task.phase !== 'done' && task.phase !== 'error' && task.phase !== 'canceled') {
        return task;
      }
    }
    // Dedup 2: has this exact URL been imported before and is the video
    // still on disk (not soft-deleted)? Short-circuit to a 'done' task
    // carrying the existing sha — no re-download, no yt-dlp spawn. The
    // SSE stream will immediately emit the done frame and the client
    // navigates to the player. Mirrors how the post-download SHA dedup
    // works but happens before any network I/O.
    const existing = lookupExistingImport(url);
    if (existing) {
      const id = randomUUID();
      const task: UrlImportTask = {
        id,
        url,
        phase: 'done',
        outputPath: null,
        ext: existing.ext,
        originalName: existing.originalName,
        lastFrame: { phase: 'done', hash: existing.sha },
        createdAt: Date.now(),
      };
      this.tasks.set(id, task);
      // Touch last_opened_at so the library reordering reflects this visit.
      touchVideoOpenedAt(existing.sha);
      return task;
    }
    const id = randomUUID();
    const task: UrlImportTask = {
      id,
      url,
      phase: 'queued',
      outputPath: null,
      ext: guessExtFromUrl(url),
      originalName: null,
      lastFrame: { phase: 'queued' },
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    void this.tryStartNext();
    return task;
  }

  getTask(id: string): UrlImportTask | undefined {
    return this.tasks.get(id);
  }

  /** Start the next queued task if nothing is running. */
  async tryStartNext(): Promise<void> {
    if (this.current) return;
    const nextId = this.queue.shift();
    if (!nextId) return;
    const task = this.tasks.get(nextId);
    if (!task) {
      // Stale id (task dropped). Recurse to grab the next one. We have not
      // reserved the slot yet, so this is safe.
      return this.tryStartNext();
    }
    // Reserve the slot *synchronously* — before any await. Two concurrent
    // ensureTask() calls must both see this populated and bail out of
    // tryStartNext(), even though runTask() below will await mkdir/spawn.
    // The proc is filled in once yt-dlp is launched; cancel() tolerates null.
    this.current = { task, proc: null };
    await this.runTask(task);
  }

  private emit(taskId: string, frame: UrlImportProgressFrame): void {
    const task = this.tasks.get(taskId);
    if (task) task.lastFrame = frame;
    const set = this.listeners.get(taskId);
    if (set) for (const fn of set) fn(frame);
  }

  /**
   * Subscribe to a task's progress. Yields the full history of frames
   * captured so far (so a late SSE attacher sees where we are), then
   * live frames until the task reaches a terminal phase.
   */
  async *attach(taskId: string): AsyncIterable<UrlImportProgressFrame> {
    const queue: UrlImportProgressFrame[] = [];
    let resolve: (() => void) | null = null;
    const onFrame = (frame: UrlImportProgressFrame): void => {
      queue.push(frame);
      resolve?.();
      resolve = null;
    };
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(onFrame);

    const task = this.tasks.get(taskId);
    if (task?.lastFrame) queue.push(task.lastFrame);

    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
        while (queue.length > 0) {
          const frame = queue.shift()!;
          yield frame;
          if (frame.phase === 'done' || frame.phase === 'error' || frame.phase === 'canceled') {
            return;
          }
        }
      }
    } finally {
      set.delete(onFrame);
    }
  }

  /** Cancel the running task (if any) for a given id. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    // Remove from pending queue.
    const qi = this.queue.indexOf(taskId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      task.phase = 'canceled';
      this.emit(taskId, { phase: 'canceled' });
      return true;
    }
    if (this.current?.task.id === taskId) {
      // proc may be null in the window between tryStartNext() reserving
      // the slot and runTask() attaching the spawned yt-dlp. If the user
      // cancels in that window there is nothing to SIGTERM yet; the
      // runTask() loop checks task.phase === 'canceled' after spawn and
      // tears down without launching work.
      this.current.proc?.kill('SIGTERM');
      task.phase = 'canceled';
      this.emit(taskId, { phase: 'canceled' });
      return true;
    }
    return false;
  }

  private async runTask(task: UrlImportTask): Promise<void> {
    // Per-task download dir under SUBCAST_PATHS.tmp/urlimport/<id>/.
    const workDir = join(SUBCAST_PATHS.tmp, 'urlimport', task.id);
    try {
      await this.runTaskInner(task, workDir);
    } catch (err: unknown) {
      // runTaskInner throws on yt-dlp non-zero exit, finalize failure, size
      // cap violation, or unexpected FS/spawn errors. task.phase tells us
      // which leg we were on so the diagnostics event stays meaningful
      // (download vs finalize), matching the pre-refactor split.
      const msg = err instanceof Error ? err.message : String(err);
      if (task.phase !== 'canceled' && task.phase !== 'done') {
        const inFinalize = task.phase === 'finalizing';
        task.phase = 'error';
        this.emit(task.id, { phase: 'error', error: msg });
        logEvent({
          level: 'warn',
          event: inFinalize ? 'url_import_finalize_failed' : 'url_import_failed',
          message: msg,
        });
      }
      void this.cleanupWorkDir(workDir);
    } finally {
      // The slot was reserved synchronously in tryStartNext(); release it
      // here unconditionally so an exception (mkdir, spawn error, etc.)
      // cannot leave the queue stuck with a phantom current task forever.
      if (this.current?.task.id === task.id) this.current = null;
      void this.tryStartNext();
    }
  }

  private async runTaskInner(task: UrlImportTask, workDir: string): Promise<void> {
    await mkdir(workDir, { recursive: true });
    // P1 follow-up: cancel() may have flipped task.phase to 'canceled' during
    // the await above — this is the window between tryStartNext() reserving
    // the slot (proc = null) and runTask attaching a real ChildProcess.
    // Without this check we'd overwrite phase back to 'fetching_info' and
    // spawn yt-dlp anyway, defeating the cancel. Return here and let
    // runTask()'s finally release the slot + start the next queued task.
    // (Read phase as the full union; TS can't see cancel()'s cross-method
    // mutation.)
    if ((task.phase as UrlImportPhase) === 'canceled') {
      return;
    }
    const outTemplate = join(workDir, `video${task.ext}`);
    task.outputPath = outTemplate;
    task.phase = 'fetching_info';
    this.emit(task.id, { phase: 'fetching_info' });

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      // Network resilience: web-video CDNs (ScreenPal, Bilibili edge
      // nodes) frequently stall mid-read. yt-dlp's default socket timeout
      // is short enough that a slow CDN response surfaces as a hard
      // "Read timed out" error. Bump the per-read timeout and retry
      // fragments a few times before giving up.
      '--socket-timeout', '60',
      '--retries', '10',
      '--fragment-retries', '10',
      // SSL UNEXPECTED_EOF_WHILE_READING on long downloads is almost always
      // an IPv6 path problem — many CDN IPv6 routes drop the TLS session
      // mid-stream while the IPv4 path is stable. Pin IPv4 so we never
      // attempt the flaky route. (Reported by a 0.4.5 user hitting this
      // against a hosted-video CDN; standard yt-dlp mitigation.)
      '--force-ipv4',
      // Back off between retries instead of hammering the server. yt-dlp's
      // --retry-sleep takes the form <TYPE>:<EXPR> where TYPE is singular
      // (http / extractor / fragment) and EXPR is *one* expression — you
      // cannot combine a fixed delay and a mode with a comma. We use
      // exponential (1s -> 2s -> 4s ...) so rapid reconnects don't look
      // like abuse and trigger harder rate-limiting / SSL EOF from the CDN.
      // (The previous 'http:5,exponential' made yt-dlp reject every argv
      // with "invalid http retry sleep expression".)
      '--retry-sleep', 'http:exponential',
      // P2.3: hard cap at the same 2GB the local upload path enforces.
      // yt-dlp aborts the download once the *streamed* byte count crosses
      // this; we re-verify the merged file size on disk below because some
      // extractors under-report and the merge can grow past the cap.
      '--max-filesize', String(MAX_IMPORT_BYTES),
      // Structured progress — one line per tick, tolerant to parse.
      '--progress-template',
      'PROGRESS %(progress._percent_str)s of %(progress._total_bytes_str)s at %(progress._speed_str)s ETA %(progress._eta_str)s',
      // Prefer mp4 container when available so downstream whisper/ffmpeg
      // don't need a remux step; merge into a single mp4.
      '--merge-output-format',
      'mp4',
      '-o',
      outTemplate,
      task.url,
    ];

    // Inherit the user's proxy env (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY)
    // so yt-dlp can reach sites that require a proxy. Electron's spawn
    // doesn't auto-forward these; without this, a user behind a proxy
    // gets "Read timed out" on every international URL even though their
    // terminal works fine. yt-dlp honors these env vars natively.
    const spawnEnv = { ...process.env };

    const proc = spawn(YT_DLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    // We reserved this.current in tryStartNext() with proc = null. Now that
    // yt-dlp has actually launched, attach the ChildProcess so cancel()
    // can signal it.
    if (this.current?.task.id === task.id) {
      this.current.proc = proc;
    }

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');

    // yt-dlp writes progress to stdout. Buffer whole lines.
    let stdoutPending = '';
    proc.stdout?.on('data', (chunk: string) => {
      stdoutPending += chunk;
      stdoutBuf.push(chunk);
      let nl: number;
      while ((nl = stdoutPending.indexOf('\n')) >= 0) {
        const line = stdoutPending.slice(0, nl);
        stdoutPending = stdoutPending.slice(nl + 1);
        this.handleLine(task.id, line);
      }
    });
    let stderrPending = '';
    proc.stderr?.on('data', (chunk: string) => {
      stderrPending += chunk;
      stderrBuf.push(chunk);
      let nl: number;
      while ((nl = stderrPending.indexOf('\n')) >= 0) {
        const line = stderrPending.slice(0, nl);
        stderrPending = stderrPending.slice(nl + 1);
        // yt-dlp routes some progress to stderr too; parse generously.
        this.handleLine(task.id, line);
      }
    });

    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.once('error', () => resolve());
    });

    const code = proc.exitCode;
    // task.phase may have been flipped to 'canceled' by cancel() from
    // another code path (an IPC / API call) while we were awaiting the
    // process exit. Read it as the full union — TS control-flow narrowing
    // can't see the cross-method mutation.
    const canceled: boolean = (task.phase as UrlImportPhase) === 'canceled';
    if (canceled) {
      // cleanupWorkDir + tryStartNext are handled by runTask()'s finally.
      return;
    }
    if (code !== 0) {
      const msg = extractYtDlpError(stderrBuf.join('')) || `yt-dlp exited with code ${code}`;
      throw new Error(msg);
    }

    // Success: locate the downloaded file (yt-dlp may have merged into a
    // different final name) and hash → upsert.
    task.phase = 'finalizing';
    this.emit(task.id, { phase: 'finalizing' });
    const finalFile = await this.findDownloadedFile(workDir, task.ext);
    if (!finalFile) throw new Error('yt-dlp reported success but no output file was found');
    // P2.3: enforce the same 2GB cap as local uploads. yt-dlp already had
    // --max-filesize 2G passed (see args), but a) some extractors don't
    // honour it consistently and b) post-merge the merged file can exceed
    // the per-stream size. Belt-and-braces: verify on disk before we move
    // it into the library.
    const sizeOnDisk = statSync(finalFile).size;
    if (sizeOnDisk > MAX_IMPORT_BYTES) {
      throw new Error(`downloaded file exceeds the 2GB limit (${(sizeOnDisk / 1024 / 1024).toFixed(0)} MiB)`);
    }
    const sha = await hashFile(finalFile);
    // P2.2: persist the *actual* extension from the file yt-dlp produced,
    // not the URL-derived guess. Storing a downloaded .m4a/.webm/.mp3 as
    // .mp4 would make /api/video serve it with the wrong Content-Type and
    // break the <video>/<audio> element. Fallback to .mp4 for anything
    // unrecognized so we never write a row with an empty/strange ext.
    const realExt = normalizeMediaExt(extname(finalFile));
    const finalPath = join(SUBCAST_PATHS.videos, `${sha}${realExt}`);
    await mkdir(SUBCAST_PATHS.videos, { recursive: true });
    if (existsSync(finalPath)) {
      // Same content already imported — discard the new download.
      await rm(finalFile, { force: true });
    } else {
      await rename(finalFile, finalPath);
    }
    const originalName = await this.guessOriginalName(task.url, realExt);
    upsertVideo(sha, originalName, realExt, task.url);
    void this.prewarmWaveform(finalPath, sha);
    task.phase = 'done';
    this.emit(task.id, { phase: 'done', hash: sha });
  }

  private handleLine(taskId: string, line: string): void {
    const frame = parseProgressLine(line);
    if (frame) this.emit(taskId, frame);
  }

  private async findDownloadedFile(workDir: string, _ext: string): Promise<string | null> {
    // Look for any media file in the work dir. yt-dlp may leave
    // video.mp4 or video.<otherext> or a merged file. Reuse the canonical
    // ALLOWED_MEDIA_EXTS list so the accepted-extensions truth lives in
    // one place (previously this regex had a duplicated `m4a` alternative
    // and could drift from normalizeMediaExt's allowed set).
    const entries = await readdir(workDir);
    const allowed = ALLOWED_MEDIA_EXTS.map((e) => e.slice(1)).join('|');
    const mediaExt = new RegExp(`\\.(${allowed})$`, 'i');
    const hit = entries.find((e) => mediaExt.test(e));
    if (hit) return join(workDir, hit);
    // Fall back to the template name regardless of extension.
    const fallback = entries.find((e) => e.startsWith('video'));
    return fallback ? join(workDir, fallback) : null;
  }

  private async guessOriginalName(url: string, ext: string): Promise<string> {
    // Defer to the pure helper for the slug logic; on URL parse failure fall
    // back to a counter-suffixed name so two failed parses don't collide.
    // (Kept as an instance method to access jobCounter; the real logic lives
    // in buildOriginalName so it can be unit-tested directly.)
    try {
      new URL(url);
    } catch {
      return `url-import-${this.jobCounter++}${ext}`;
    }
    return buildOriginalName(url, ext);
  }

  private async cleanupWorkDir(workDir: string): Promise<void> {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  private async prewarmWaveform(finalPath: string, sha: string): Promise<void> {
    try {
      const peaks = await generateWaveform(finalPath);
      const cacheDir = join(SUBCAST_PATHS.cache, sha);
      await mkdir(cacheDir, { recursive: true });
      await writeFileAsync(
        join(cacheDir, 'waveform.json'),
        JSON.stringify({ version: 1, peaks }),
      );
      getDb()
        .prepare('UPDATE videos SET has_waveform = 1 WHERE sha256 = ?')
        .run(sha);
    } catch (err: unknown) {
      logEvent({
        level: 'warn',
        event: 'waveform_prewarm_failed',
        sha,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Stream-hash a file (same pattern as upload.post.ts). */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest('hex');
}

/**
 * Look up a previously-imported video by its source URL. Returns the sha
 * + metadata only when the row exists, is not soft-deleted, and the
 * media file is still on disk — so a user who deleted the video gets a
 * fresh re-download rather than a dangling pointer.
 */
function lookupExistingImport(url: string): { sha: string; ext: string; originalName: string } | null {
  const row = getDb()
    .prepare(
      `SELECT sha256, ext, original_name FROM videos
       WHERE source_url = ? AND deleted_at IS NULL`,
    )
    .get(url) as { sha256: string; ext: string; original_name: string } | undefined;
  if (!row) return null;
  // Guard against a stale row whose file was removed out-of-band.
  const mediaPath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);
  if (!existsSync(mediaPath)) return null;
  return { sha: row.sha256, ext: row.ext, originalName: row.original_name };
}

/** Bump last_opened_at for a video (library recency reordering). */
function touchVideoOpenedAt(sha: string): void {
  getDb()
    .prepare('UPDATE videos SET last_opened_at = ? WHERE sha256 = ?')
    .run(Date.now(), sha);
}

/** videos upsert — mirrors upload.post.ts ON CONFLICT logic, plus source_url. */
function upsertVideo(sha: string, originalName: string, ext: string, sourceUrl: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET
         last_opened_at = excluded.last_opened_at,
         deleted_at = NULL,
         source_url = COALESCE(excluded.source_url, videos.source_url)`,
    )
    .run(sha, originalName, ext, 0, now, now, sourceUrl);
}

export const urlImportQueue = new UrlImportQueue();
