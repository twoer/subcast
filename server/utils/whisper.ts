/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import type { WhisperModelName } from '#shared/whisperModels';
import { parseVtt, type Cue } from './vtt';
import { WHISPER_CLI_PATH, whisperModelPath } from './whisperPaths';
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpegPaths';
import { runProcess } from './process';

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
 * Slice the wav at [startSec, endSec) and transcribe just that segment via
 * whisper-cli. Returns cues with timestamps **adjusted to absolute time** in
 * the source video (i.e., already offset by startSec*1000).
 *
 * Caller is responsible for the parent wav's lifecycle. This function cleans
 * up its own per-chunk wav slice and VTT artifact. The caller passes an
 * explicit `(startSec, endSec)` range — chunk planning is no longer the
 * concern of this function (see `shared/chunking.ts` for the two planners).
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
