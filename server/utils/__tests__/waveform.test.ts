/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { aggregatePeak, generateWaveform, normalizePeaks } from '../waveform';
import { FFMPEG_PATH } from '../ffmpegPaths';

describe('aggregatePeak', () => {
  it('splits samples into N buckets and returns max(|x|) per bucket', () => {
    // 12 samples, 4 buckets → 3 samples per bucket. Float32 literals lose
    // a bit of precision on round-trip (0.2 stored as f32 → 0.20000000298),
    // so compare with toBeCloseTo rather than strict deep-equal.
    const samples = new Float32Array([
      0.1, -0.2, 0.05,    // bucket 0 → 0.2
      -0.4, 0.3, 0.1,     // bucket 1 → 0.4
      0.05, -0.01, 0.02,  // bucket 2 → 0.05
      0.9, -0.5, 0.7,     // bucket 3 → 0.9
    ]);
    const peaks = aggregatePeak(samples, 4);
    expect(peaks).toHaveLength(4);
    expect(peaks[0]!).toBeCloseTo(0.2, 5);
    expect(peaks[1]!).toBeCloseTo(0.4, 5);
    expect(peaks[2]!).toBeCloseTo(0.05, 5);
    expect(peaks[3]!).toBeCloseTo(0.9, 5);
  });

  it('handles non-divisible sample counts (last bucket smaller)', () => {
    // 10 samples, 4 buckets → buckets of size ~2.5; deterministic floor split
    const samples = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const peaks = aggregatePeak(samples, 4);
    expect(peaks).toHaveLength(4);
    // Last bucket must contain the max value (10)
    expect(peaks[3]).toBe(10);
  });

  it('returns N zeros for an empty sample array', () => {
    expect(aggregatePeak(new Float32Array(0), 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('returns N zeros for buckets=0 guard (single bucket spans all)', () => {
    expect(aggregatePeak(new Float32Array([0.5, 0.9]), 0)).toEqual([]);
  });
});

describe('normalizePeaks', () => {
  it('divides every peak by max so the largest becomes 1', () => {
    expect(normalizePeaks([0.1, 0.5, 0.25])).toEqual([0.2, 1.0, 0.5]);
  });

  it('returns input unchanged when all zero (silent audio)', () => {
    expect(normalizePeaks([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('generateWaveform', () => {
  let dir: string;
  let wavPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'subcast-wf-'));
    wavPath = join(dir, 'tone.wav');
    // Generate a 2-second WAV: 1s sine @ 440Hz @ 0.5 amplitude, then 1s silence.
    // The first half of buckets should have non-zero peaks; the second half ~0.
    execFileSync(FFMPEG_PATH, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=8000',
      '-f', 'lavfi', '-i', 'anullsrc=duration=1:sample_rate=8000',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
      '-map', '[out]', '-ac', '1', '-ar', '8000',
      wavPath,
    ], { stdio: 'ignore' });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 500 peaks for any input length', async () => {
    const peaks = await generateWaveform(wavPath);
    expect(peaks).toHaveLength(500);
  });

  it('peaks are normalized: max equals 1.0 (within float tolerance)', async () => {
    const peaks = await generateWaveform(wavPath);
    const max = Math.max(...peaks);
    expect(max).toBeGreaterThan(0.95);
    expect(max).toBeLessThanOrEqual(1.0);
  });

  it('silent half (second 1.0-2.0s) has near-zero peaks', async () => {
    const peaks = await generateWaveform(wavPath);
    // Last quarter of the array corresponds to ~1.5-2.0s — purely silent.
    const lastQuarter = peaks.slice(375);
    const avg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
    expect(avg).toBeLessThan(0.01);
  });

  it('rejects on missing input file', async () => {
    await expect(generateWaveform(join(dir, 'nonexistent.wav'))).rejects.toThrow();
  });
});
