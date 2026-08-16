/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { WhisperModelName } from '#shared/whisperModels';
import { parseVtt, type Cue } from './vtt';
import { getWhisperServer } from './whisperServer';
import { WHISPER_CLI_PATH, whisperModelPath } from './whisperPaths';
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpegPaths';
import { logEvent } from './log';
import { runProcess } from './process';
import { sliceWavToBuffer } from './wavSlice';

export interface TranscribeOptions {
  model?: WhisperModelName;
  /** Whisper sampling temperature. Default 0 (greedy). Higher = more diverse. */
  temperature?: number;
  /**
   * If true, pass --no-context to whisper-cli (i.e., disable
   * condition_on_previous_text). Used by F2 hallucination retries when the
   * default greedy pass produces repetitive output.
   */
  noContext?: boolean;
  /**
   * Cancellation hook. Plumbed through to every child process; when fired
   * the worker's ffmpeg / whisper-cli children are killed within
   * `killGraceMs` (default 2s) instead of running to completion.
   */
  signal?: AbortSignal;
}

// Hard upper bounds. These are SAFETY ceilings, not SLAs — a healthy run
// finishes well under. Hitting them means something is wedged.
const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_EXTRACT_TIMEOUT_MS = 60 * 60 * 1000; // 1h: full-video wav extract

export async function probeDurationS(
  absPath: string,
  signal?: AbortSignal,
): Promise<number> {
  const r = await runProcess(
    FFPROBE_PATH,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      absPath,
    ],
    { label: 'ffprobe', timeoutMs: FFPROBE_TIMEOUT_MS, signal },
  );
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  const v = parseFloat(r.stdout.trim());
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`ffprobe returned invalid duration: ${r.stdout}`);
  }
  return v;
}

export async function extractWav(
  absPath: string,
  wavPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const r = await runProcess(
    FFMPEG_PATH,
    [
      '-i',
      absPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath,
      '-y',
    ],
    { label: 'ffmpeg-extract', timeoutMs: FFMPEG_EXTRACT_TIMEOUT_MS, signal },
  );
  if (r.code !== 0) throw new Error(`ffmpeg extract failed: ${r.stderr}`);
}

function assertWhisperReady(model: string): string {
  if (!existsSync(WHISPER_CLI_PATH)) {
    throw new Error(
      `whisper-cli not built at ${WHISPER_CLI_PATH}. Run: cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli`,
    );
  }
  const modelPath = whisperModelPath(model);
  if (!existsSync(modelPath)) {
    throw new Error(
      `Model not downloaded: ${modelPath}. Run: npx nodejs-whisper download ${model}`,
    );
  }
  return modelPath;
}

/**
 * Slice the wav at [startSec, endSec) and transcribe just that segment,
 * returning cues with timestamps **adjusted to absolute time** in the
 * source video (i.e., already offset by startSec*1000).
 *
 * Two execution paths, tried in order:
 *
 *   1. whisper-server sidecar — model stays resident across chunks;
 *      the slice is POSTed as multipart bytes (no temp file, no spawn).
 *   2. whisper-cli spawn — the original path, kept as fallback for
 *      unstaged servers / mid-task server deaths.
 *
 * Caller is responsible for the parent wav's lifecycle. This function cleans
 * up its own per-chunk wav slice and VTT artifact (CLI path only). The
 * caller passes an explicit `(startSec, endSec)` range — chunk planning is
 * no longer the concern of this function (see `shared/chunking.ts` for the
 * two planners).
 */
export async function transcribeChunk(
  wavPath: string,
  chunkIdx: number,
  startSec: number,
  endSec: number,
  opts: TranscribeOptions = {},
): Promise<Cue[]> {
  const model = opts.model ?? 'base';
  const modelPath = assertWhisperReady(model);
  const signal = opts.signal;

  const chunkSec = Math.max(0, endSec - startSec);
  const sliceWavPath = wavPath.replace(/\.wav$/, `-chunk${chunkIdx}.wav`);

  // Slice once, in memory, for BOTH paths — the parent is our own
  // pcm_s16le extract, so a byte-range copy is exact and saves the
  // per-chunk ffmpeg spawn. ffmpeg remains the fallback for any layout
  // the in-memory slicer refuses.
  let sliceBuf: Buffer | null = null;
  try {
    sliceBuf = sliceWavToBuffer(wavPath, startSec, endSec).wav;
  } catch (err) {
    logEvent({
      level: 'warn',
      event: 'wav_slice_ffmpeg_fallback',
      chunkIdx,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Path 1: resident whisper-server (pure inference + HTTP per chunk).
  if (sliceBuf !== null) {
    try {
      return await transcribeChunkViaServer(sliceBuf, startSec, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      logServerFallback(chunkIdx, err);
    }
  }

  // Path 2: whisper-cli spawn (original path).
  if (sliceBuf !== null) {
    await writeFile(sliceWavPath, sliceBuf);
  } else {
    // ffmpeg slice is bounded by chunk duration; allow 30× real-time as a
    // wedged-process ceiling (i.e. 30s chunk → 15 min cap).
    const ffSliceTimeoutMs = Math.max(60_000, chunkSec * 30 * 1000);
    const ff = await runProcess(
      FFMPEG_PATH,
      [
        '-i',
        wavPath,
        '-ss',
        String(startSec),
        '-to',
        String(endSec),
        '-c:a',
        'pcm_s16le',
        sliceWavPath,
        '-y',
      ],
      { label: 'ffmpeg-slice', timeoutMs: ffSliceTimeoutMs, signal },
    );
    if (ff.code !== 0) {
      throw new Error(`ffmpeg slice chunk ${chunkIdx} failed: ${ff.stderr}`);
    }
  }

  const ofPrefix = sliceWavPath.replace(/\.wav$/, '');
  try {
    // NOTE: do NOT pass `-ml N` here. whisper.cpp's max-segment-length
    // truncation is byte-oriented and slices CJK characters mid-UTF-8,
    // producing U+FFFD replacement chars for Chinese / Japanese / Korean
    // input. Letting whisper segment at natural silence boundaries gives
    // longer-but-clean cues that the cue list still renders fine.
    const args: string[] = [
      '-m', modelPath,
      '-f', sliceWavPath,
      '--output-vtt',
      '-of', ofPrefix,
      '-l', 'auto',
    ];
    if (typeof opts.temperature === 'number') {
      args.push('-tp', String(opts.temperature));
    }
    if (opts.noContext) {
      // whisper-cli has no `--no-context`; set max-context tokens to 0,
      // which disables condition_on_previous_text equivalently.
      args.push('-mc', '0');
    }
    // 60× real-time ceiling on whisper-cli — enough headroom for slow CPUs
    // running large models; tighter than wallclock-infinity.
    const whisperTimeoutMs = Math.max(60_000, chunkSec * 60 * 1000);
    const wc = await runProcess(WHISPER_CLI_PATH, args, {
      label: 'whisper-cli',
      timeoutMs: whisperTimeoutMs,
      signal,
    });
    if (wc.code !== 0) {
      throw new Error(`whisper-cli chunk ${chunkIdx} failed: ${wc.stderr}`);
    }

    const vttPath = `${ofPrefix}.vtt`;
    const vtt = await readFile(vttPath, 'utf8');
    const rawCues = parseVtt(vtt);
    await unlink(vttPath).catch(() => {});

    const offsetMs = Math.round(startSec * 1000);
    return rawCues.map((cue) => ({
      startMs: cue.startMs + offsetMs,
      endMs: cue.endMs + offsetMs,
      text: cue.text,
    }));
  } finally {
    await unlink(sliceWavPath).catch(() => {});
  }
}

/**
 * Transcribe one in-memory WAV slice via the resident whisper-server
 * sidecar. Form-field contract locked against whisper.cpp v1.8.4
 * `examples/server/server.cpp` (`get_req_parameters`): file /
 * response_format / temperature / no_context / language. VTT timestamps
 * come back relative to the slice — same offset fix-up as the CLI path.
 */
async function transcribeChunkViaServer(
  sliceWav: Buffer,
  startSec: number,
  opts: TranscribeOptions,
): Promise<Cue[]> {
  const server = getWhisperServer();
  await server.ensure();
  const port = server.getPort();
  if (port == null) {
    throw new Error('whisper-server reported no port after ensure()');
  }
  const form = new FormData();
  // Uint8Array view — TS rejects Node's Buffer<ArrayBufferLike> as a
  // BlobPart even though undici accepts it at runtime.
  form.append('file', new Blob([new Uint8Array(sliceWav)]), 'chunk.wav');
  form.append('response_format', 'vtt');
  form.append('language', 'auto');
  if (typeof opts.temperature === 'number') {
    form.append('temperature', String(opts.temperature));
  }
  if (opts.noContext) {
    form.append('no_context', 'true');
  }
  // 60× real-time ceiling, mirroring the whisper-cli spawn timeout.
  // Math.round is load-bearing: Node's AbortSignal.timeout rejects
  // non-integer delays with a RangeError, and bytes/32000×60000 is
  // virtually always fractional (bit us live: every chunk fell back
  // to the CLI spawn path with "delay is out of range").
  const timeoutMs = Math.max(60_000, Math.round((sliceWav.length / 32_000) * 60 * 1000));
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSig]) : timeoutSig;
  const res = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST',
    body: form,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`whisper-server returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const vtt = await res.text();
  server.noteSuccess();
  const offsetMs = Math.round(startSec * 1000);
  return parseVtt(vtt).map((cue) => ({
    startMs: cue.startMs + offsetMs,
    endMs: cue.endMs + offsetMs,
    text: cue.text,
  }));
}

/**
 * Warn loudly the first time a chunk falls back from whisper-server to
 * whisper-cli; binary-missing (older staging without the server) is
 * expected and degrades permanently, so it logs once and then quiets
 * down to debug instead of spamming one warn per chunk.
 */
let serverBinaryMissingLogged = false;
function logServerFallback(chunkIdx: number, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const binaryMissing = msg.includes('WHISPER_SERVER_BINARY_MISSING');
  if (binaryMissing && serverBinaryMissingLogged) {
    logEvent({ level: 'debug', event: 'whisper_server_fallback_cli', chunkIdx, error: msg });
    return;
  }
  if (binaryMissing) serverBinaryMissingLogged = true;
  logEvent({ level: 'warn', event: 'whisper_server_fallback_cli', chunkIdx, error: msg });
}
