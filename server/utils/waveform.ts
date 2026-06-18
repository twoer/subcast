/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Pure helpers + ffmpeg wrapper that produce the per-video peak array
 * used by the player's waveform progress bar.
 */

import { spawn } from 'node:child_process';
import { FFMPEG_PATH } from './ffmpegPaths';
import { logEvent } from './log';

/**
 * Walk `samples` left-to-right, assign each sample to one of `buckets`
 * consecutive buckets, and return max(|sample|) per bucket. The split
 * uses floor(idx * buckets / samples.length) so non-divisible counts
 * fall into the last bucket — keeps the final visualization aligned to
 * the right edge instead of leaving a runt bucket empty.
 *
 * Returns an N-element array; all zeros for an empty input.
 */
export function aggregatePeak(samples: Float32Array, buckets: number): number[] {
  if (buckets <= 0) return [];
  const peaks = new Array<number>(buckets).fill(0);
  if (samples.length === 0) return peaks;
  for (let i = 0; i < samples.length; i++) {
    const b = Math.min(buckets - 1, Math.floor((i * buckets) / samples.length));
    const a = Math.abs(samples[i]!);
    if (a > peaks[b]!) peaks[b] = a;
  }
  return peaks;
}

/**
 * Scale a peak array so its maximum equals 1.0. Bars then use the full
 * canvas height. A genuinely silent audio file (max === 0) is returned
 * unchanged — divide-by-zero would make the visualization meaningless
 * anyway and an all-zero bar is the correct rendering.
 */
export function normalizePeaks(peaks: readonly number[]): number[] {
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  if (max === 0) return peaks.slice();
  return peaks.map((p) => p / max);
}

export interface GenerateWaveformOptions {
  /** How many bars to produce. Default 500 — matches the player canvas pitch. */
  buckets?: number;
  /** Decode rate (Hz). Default 1000 — caps the in-flight buffer at <15MB for a 1h video. */
  sampleRate?: number;
  /** External cancellation. The ffmpeg child is killed (SIGTERM) on abort. */
  signal?: AbortSignal;
}

const DEFAULT_BUCKETS = 500;
const DEFAULT_SAMPLE_RATE = 1000;
// 50MB ceiling of decoded mono f32 PCM ≈ 3.5h at 1kHz. Beyond that we
// abort instead of risking an OOM. Hand-uploaded podcasts longer than
// this are vanishingly rare; the bound is a guardrail, not a SLA.
const MAX_PCM_BYTES = 50 * 1024 * 1024;

/**
 * Decode `audioPath` to mono f32le PCM via the bundled ffmpeg, buffer the
 * samples (with a hard size ceiling), then run the pure aggregator. We
 * accumulate-then-aggregate rather than stream-aggregate because the
 * aggregator needs the total sample count up front to compute bucket
 * boundaries; ffmpeg's `-t` duration metadata is not reliable on damaged
 * inputs, so we let the actual sample count be authoritative.
 */
export function generateWaveform(
  audioPath: string,
  opts: GenerateWaveformOptions = {},
): Promise<number[]> {
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;

  return new Promise<number[]>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', audioPath,
      '-vn',
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-',
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    logEvent({ level: 'debug', event: 'waveform_spawn', pid: proc.pid ?? -1, audioPath });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderrBuf = '';
    let overflow = false;

    const onAbort = (): void => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    };
    opts.signal?.addEventListener('abort', onAbort);

    proc.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PCM_BYTES) {
        overflow = true;
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

    proc.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (overflow) {
        reject(new Error(`waveform input exceeds ${MAX_PCM_BYTES} bytes of decoded PCM`));
        return;
      }
      if (opts.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrBuf.trim()}`));
        return;
      }
      // Concatenate, ensure 4-byte alignment (f32 = 4 bytes/sample).
      const all = Buffer.concat(chunks, totalBytes);
      const aligned = all.subarray(0, Math.floor(all.length / 4) * 4);
      const samples = new Float32Array(
        aligned.buffer,
        aligned.byteOffset,
        aligned.byteLength / 4,
      );
      const peaks = aggregatePeak(samples, buckets);
      resolve(normalizePeaks(peaks));
    });
  });
}
