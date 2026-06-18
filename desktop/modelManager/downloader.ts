/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Resumable HTTP downloader with SHA256 verification.
 *
 * Design (decisions 26-28 + § 5.5):
 *   - Resume: HTTP Range header (`bytes=<existing>-`); writes use
 *     `createWriteStream({ flags: 'a' })`. If the server ignores Range and
 *     returns 200, we truncate and start over — there's no way to recover
 *     a partial chunk against a fresh start.
 *   - Verify: streaming SHA256 of the file on disk after completion. A
 *     mismatch deletes the file and retries once from scratch.
 *   - Retry: transient HTTP/network/stream failures retry with short
 *     exponential backoff. Partial bytes stay on disk so the next attempt
 *     can resume via Range.
 *   - Progress: callback fires at most every `progressIntervalMs` (default
 *     500ms) to avoid spamming IPC. ETA is averaged over the most recent
 *     ~5s of byte deltas.
 *   - Cancellation: pass an AbortSignal; the fetch + stream are aborted and
 *     the partial file stays on disk so the next call can resume it.
 *
 * Exposed via Nitro / IPC by callers; the downloader itself is pure.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export interface DownloadProgress {
  /** Bytes already on disk (includes resumed prefix). */
  bytesDownloaded: number;
  /** Total bytes expected, or null if the server didn't send Content-Length. */
  bytesTotal: number | null;
  /** Recent average speed in bytes/sec. */
  bytesPerSecond: number;
  /** Seconds remaining at current speed, or null if unknown. */
  etaSeconds: number | null;
}

export interface DownloadOptions {
  url: string;
  destPath: string;
  /** Lowercase hex SHA256. If omitted, verification is skipped. */
  expectedSha256?: string;
  /** Called at most every `progressIntervalMs`; never on a final 100% tick. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Default 500ms. */
  progressIntervalMs?: number;
  /** Abort the current attempt. Partial file stays for resume next time. */
  signal?: AbortSignal;
  /**
   * Hash-failure retries from scratch. Default 1 (so two total attempts).
   */
  maxHashRetries?: number;
  /** Transient HTTP/network/stream retries. Default 2 (so three total attempts). */
  maxNetworkRetries?: number;
  /** Base delay for transient retries. Default 800ms. */
  retryDelayMs?: number;
  /**
   * Injected `fetch` for testing. Defaults to `globalThis.fetch`.
   * @internal
   */
  fetchImpl?: typeof globalThis.fetch;
}

export interface DownloadResult {
  destPath: string;
  bytesDownloaded: number;
  /** Computed SHA256 (lowercase hex). */
  sha256: string;
  /** True if this attempt resumed an existing partial file. */
  resumed: boolean;
}

export class HashMismatchError extends Error {
  constructor(public readonly expected: string, public readonly actual: string) {
    super(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    this.name = 'HashMismatchError';
  }
}

export class HttpDownloadError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
  ) {
    super(`download failed: ${status} ${statusText} for ${url}`);
    this.name = 'HttpDownloadError';
  }
}

const SPEED_WINDOW_MS = 5_000;

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function isAbortError(err: unknown): boolean {
  return (err as Error | undefined)?.name === 'AbortError';
}

function isRetriableDownloadError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof HttpDownloadError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC') return false;
  return true;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(resolve, ms);
    onAbort = (): void => {
      if (timer) clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  }).finally(() => {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

/**
 * Download `url` to `destPath`. Resumes from any existing prefix.
 * Throws on network failure, abort, or — after retries — hash mismatch.
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const {
    url,
    destPath,
    expectedSha256,
    onProgress,
    progressIntervalMs = 500,
    signal,
    maxHashRetries = 1,
    maxNetworkRetries = 2,
    retryDelayMs = 800,
    fetchImpl = globalThis.fetch,
  } = options;

  await mkdir(dirname(destPath), { recursive: true });

  let hashAttempt = 0;
  while (true) {
    const result = await downloadOnceWithRetries({
      url,
      destPath,
      onProgress,
      progressIntervalMs,
      signal,
      maxNetworkRetries,
      retryDelayMs,
      fetchImpl,
    });

    if (!expectedSha256) return result;

    const actual = await sha256OfFile(destPath);
    if (actual === expectedSha256.toLowerCase()) {
      return {
        ...result,
        sha256: actual,
      };
    }

    // Hash mismatch — the partial is unrecoverable. Delete and retry.
    await rm(destPath, { force: true });
    if (hashAttempt >= maxHashRetries) {
      throw new HashMismatchError(expectedSha256.toLowerCase(), actual);
    }
    hashAttempt += 1;
  }
}

async function downloadOnceWithRetries(options: {
  url: string;
  destPath: string;
  onProgress?: (progress: DownloadProgress) => void;
  progressIntervalMs: number;
  signal?: AbortSignal;
  maxNetworkRetries: number;
  retryDelayMs: number;
  fetchImpl: typeof globalThis.fetch;
}): Promise<DownloadResult> {
  const { signal, maxNetworkRetries, retryDelayMs } = options;

  let networkAttempt = 0;
  while (true) {
    try {
      return await downloadOnce(options);
    } catch (err) {
      if (signal?.aborted || !isRetriableDownloadError(err) || networkAttempt >= maxNetworkRetries) {
        throw err;
      }
      const delay = retryDelayMs * (2 ** networkAttempt);
      networkAttempt += 1;
      await sleep(delay, signal);
    }
  }
}

async function downloadOnce(options: {
  url: string;
  destPath: string;
  onProgress?: (progress: DownloadProgress) => void;
  progressIntervalMs: number;
  signal?: AbortSignal;
  fetchImpl: typeof globalThis.fetch;
}): Promise<DownloadResult> {
  const {
    url,
    destPath,
    onProgress,
    progressIntervalMs,
    signal,
    fetchImpl,
  } = options;

  const existing = await fileSizeOrZero(destPath);
  const resumed = existing > 0;

  const headers: Record<string, string> = {};
  if (resumed) headers.Range = `bytes=${existing}-`;

  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok && res.status !== 206) {
    throw new HttpDownloadError(res.status, res.statusText, url);
  }
  if (!res.body) {
    throw new Error(`download failed: empty body for ${url}`);
  }

  // Server may have ignored the Range header and returned 200 with the
  // full body. In that case our `existing` prefix is wrong — truncate
  // and start over with this same response.
  let appendMode = resumed && res.status === 206;
  if (resumed && res.status === 200) {
    await rm(destPath, { force: true });
    appendMode = false;
  }

  // Content-Length is the *remaining* bytes when 206, or the full size on 200.
  const contentLength = parseContentLength(res.headers.get('content-length'));
  const bytesTotal =
    contentLength !== null
      ? appendMode
        ? existing + contentLength
        : contentLength
      : null;

  const startedAt = appendMode ? existing : 0;
  let downloadedThisAttempt = 0;
  const speedSamples: Array<{ t: number; bytes: number }> = [];
  let lastProgressEmit = 0;

  function emitProgress(force = false): void {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressEmit < progressIntervalMs) return;
    lastProgressEmit = now;

    // Trim samples outside the recent window.
    const cutoff = now - SPEED_WINDOW_MS;
    while (speedSamples.length > 0 && speedSamples[0]!.t < cutoff) speedSamples.shift();

    const windowBytes = speedSamples.reduce((s, x) => s + x.bytes, 0);
    const windowMs = speedSamples.length > 0
      ? Math.max(1, now - speedSamples[0]!.t)
      : 1;
    const bytesPerSecond = (windowBytes * 1000) / windowMs;

    const bytesDownloaded = startedAt + downloadedThisAttempt;
    const etaSeconds =
      bytesTotal !== null && bytesPerSecond > 0
        ? Math.max(0, Math.round((bytesTotal - bytesDownloaded) / bytesPerSecond))
        : null;

    onProgress({ bytesDownloaded, bytesTotal, bytesPerSecond, etaSeconds });
  }

  const out = createWriteStream(destPath, { flags: appendMode ? 'a' : 'w' });
  // res.body in Node 22 is a WebReadableStream. Convert to Node Readable
  // so we can chunk-tap progress and pipeline cleanly.
  const nodeBody = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);

  nodeBody.on('data', (chunk: Buffer) => {
    downloadedThisAttempt += chunk.length;
    speedSamples.push({ t: Date.now(), bytes: chunk.length });
    emitProgress();
  });

  await pipeline(nodeBody, out, { signal });

  return {
    destPath,
    bytesDownloaded: startedAt + downloadedThisAttempt,
    sha256: await sha256OfFile(destPath),
    resumed: appendMode,
  };
}

function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
