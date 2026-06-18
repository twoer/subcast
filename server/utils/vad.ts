/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Silero VAD speech segmentation.
 *
 * Pipeline:
 *   audioPath  ──ffmpeg──▶  f32 PCM 16 kHz mono  ──ONNX──▶  per-frame probs
 *   probs      ──probsToSegments──▶  raw runs    ──refineSegments──▶  final
 *
 * The two pure helpers (`probsToSegments`, `refineSegments`) are
 * exported separately so unit tests can validate the hysteresis +
 * merge + min-duration logic without needing a real ONNX inference.
 */

import { spawn } from 'node:child_process';
import { FFMPEG_PATH } from './ffmpegPaths';
import {
  getVadSession,
  runVadFrame,
  VAD_FRAME_SAMPLES,
  VAD_STATE_SIZE,
} from './vadSession';
import { logEvent } from './log';

export interface SpeechSegment {
  startMs: number;
  endMs: number;
}

export interface DetectOptions {
  /** Threshold above which a frame is considered speech. Default 0.5. */
  enterThreshold?: number;
  /**
   * Threshold below which a speech run ends. Set lower than `enterThreshold`
   * for hysteresis — avoids flickering at word boundaries where the model
   * dips just below 0.5 between syllables. Default 0.35.
   */
  exitThreshold?: number;
  /** Drop final runs shorter than this. Default 250 ms. */
  minSegmentMs?: number;
  /** Merge gaps shorter than this between speech runs. Default 500 ms. */
  mergeGapMs?: number;
  /** External abort. */
  signal?: AbortSignal;
}

const FRAME_MS = 30;
const DEFAULT_ENTER = 0.5;
const DEFAULT_EXIT = 0.35;
const DEFAULT_MIN = 250;
const DEFAULT_MERGE = 500;

/**
 * Pure: walk a frame-by-frame probability stream through a 2-threshold
 * hysteresis state machine and emit raw (unfiltered) speech runs.
 *
 * Each probability covers `frameMs` of audio starting at index * frameMs.
 * Returns segments in milliseconds, ordered, non-overlapping.
 */
export function probsToSegments(
  probs: readonly number[],
  enterThreshold = DEFAULT_ENTER,
  exitThreshold = DEFAULT_EXIT,
  frameMs = FRAME_MS,
): SpeechSegment[] {
  if (enterThreshold < exitThreshold) {
    throw new Error('enterThreshold must be >= exitThreshold (hysteresis)');
  }
  const out: SpeechSegment[] = [];
  let inSpeech = false;
  let runStart = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!;
    const t = i * frameMs;
    if (!inSpeech && p >= enterThreshold) {
      inSpeech = true;
      runStart = t;
    } else if (inSpeech && p < exitThreshold) {
      inSpeech = false;
      out.push({ startMs: runStart, endMs: t });
    }
  }
  if (inSpeech) {
    out.push({ startMs: runStart, endMs: probs.length * frameMs });
  }
  return out;
}

/**
 * Pure: merge inter-segment gaps shorter than `mergeGapMs`, then drop
 * any remaining run shorter than `minSegmentMs`. Mutation-free: returns
 * a fresh array. `raw` must be ordered and non-overlapping (output of
 * `probsToSegments`).
 */
export function refineSegments(
  raw: readonly SpeechSegment[],
  minSegmentMs = DEFAULT_MIN,
  mergeGapMs = DEFAULT_MERGE,
): SpeechSegment[] {
  const merged: SpeechSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.startMs - last.endMs < mergeGapMs) {
      last.endMs = seg.endMs;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged.filter((s) => s.endMs - s.startMs >= minSegmentMs);
}

/**
 * Stream `audioPath` through ffmpeg → f32 PCM @ 16 kHz mono → Silero
 * VAD frame-by-frame. Returns ordered, non-overlapping speech segments
 * after hysteresis filtering, gap merging, and min-duration pruning.
 *
 * Memory is bounded: PCM is accumulated then processed, but at 16 kHz
 * mono f32 that's ~64 KB/s, so a 1 h file caps at ~230 MB which we
 * still allow. A guardrail would only kick in above ~30 h of audio,
 * outside any realistic Subcast input.
 */
export async function detectSpeechSegments(
  audioPath: string,
  opts: DetectOptions = {},
): Promise<SpeechSegment[]> {
  const enterTh = opts.enterThreshold ?? DEFAULT_ENTER;
  const exitTh = opts.exitThreshold ?? DEFAULT_EXIT;
  const minMs = opts.minSegmentMs ?? DEFAULT_MIN;
  const mergeMs = opts.mergeGapMs ?? DEFAULT_MERGE;
  const session = await getVadSession();

  return new Promise<SpeechSegment[]>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('aborted'));

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      '-vn',
      '-f', 'f32le', '-ac', '1', '-ar', '16000',
      '-',
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = (): void => {
      try { proc.kill('SIGTERM'); } catch { /* gone */ }
    };
    opts.signal?.addEventListener('abort', onAbort);

    const buf: Buffer[] = [];
    let totalBytes = 0;
    let stderr = '';

    proc.stdout.on('data', (c: Buffer) => {
      buf.push(c);
      totalBytes += c.length;
    });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    proc.on('close', async (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) return reject(new Error('aborted'));
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      }
      try {
        const all = Buffer.concat(buf, totalBytes);
        const aligned = all.subarray(0, Math.floor(all.length / 4) * 4);
        const samples = new Float32Array(
          aligned.buffer,
          aligned.byteOffset,
          aligned.byteLength / 4,
        );
        const totalFrames = Math.floor(samples.length / VAD_FRAME_SAMPLES);
        const probs: number[] = new Array(totalFrames);
        let h: Float32Array<ArrayBufferLike> = new Float32Array(VAD_STATE_SIZE);
        let c: Float32Array<ArrayBufferLike> = new Float32Array(VAD_STATE_SIZE);
        const frame = new Float32Array(VAD_FRAME_SAMPLES);
        for (let i = 0; i < totalFrames; i++) {
          if (opts.signal?.aborted) return reject(new Error('aborted'));
          frame.set(samples.subarray(i * VAD_FRAME_SAMPLES, (i + 1) * VAD_FRAME_SAMPLES));
          const r = await runVadFrame(session, frame, h, c);
          h = r.hNext;
          c = r.cNext;
          probs[i] = r.prob;
        }
        const raw = probsToSegments(probs, enterTh, exitTh, FRAME_MS);
        const final = refineSegments(raw, minMs, mergeMs);
        logEvent({
          level: 'debug',
          event: 'vad_done',
          totalFrames,
          rawSegments: raw.length,
          finalSegments: final.length,
        });
        resolve(final);
      } catch (err) {
        reject(err);
      }
    });
  });
}
