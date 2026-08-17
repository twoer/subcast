/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remapCuesToPieces } from '../whisper';
import { concatWavPiecesToBuffer, parseWavHeader } from '../wavSlice';
import type { PackedPiece } from '#shared/chunking';
import type { Cue } from '../vtt';

const cue = (startMs: number, endMs: number, text = 'x'): Cue => ({
  startMs,
  endMs,
  text,
});

describe('remapCuesToPieces', () => {
  const pieces: PackedPiece[] = [
    { reqStartMs: 0, absStartMs: 10_000, durMs: 5_000 },
    { reqStartMs: 5_000, absStartMs: 40_000, durMs: 5_000 },
  ];

  it('single piece maps like a plain offset', () => {
    const single: PackedPiece[] = [{ reqStartMs: 0, absStartMs: 10_000, durMs: 5_000 }];
    expect(remapCuesToPieces([cue(1_000, 2_000, 'hi')], single)).toEqual([
      cue(11_000, 12_000, 'hi'),
    ]);
  });

  it('maps cues in later pieces through their own offset', () => {
    expect(remapCuesToPieces([cue(6_000, 8_000, 'a')], pieces)).toEqual([
      cue(41_000, 43_000, 'a'),
    ]);
  });

  it('extends a seam-crossing cue into the next piece, capped at 2 s past the seam', () => {
    // Starts 1 s into piece 0 (abs 11s), ends 1 s INTO piece 1 (abs 41s):
    // concatenated speech flows across seams, so the end maps through
    // piece 1 — but capped at piece 0's end + 2 s (never span the gap).
    expect(remapCuesToPieces([cue(1_000, 6_000, 'flow')], pieces)).toEqual([
      cue(11_000, 17_000, 'flow'),
    ]);
    // Same cue ending past the tolerance stays clamped harder.
    expect(remapCuesToPieces([cue(4_900, 9_500, 'drift')], pieces)).toEqual([
      cue(14_900, 17_000, 'drift'),
    ]);
  });

  it('drops cues that start outside every piece', () => {
    expect(remapCuesToPieces([cue(10_500, 11_000)], pieces)).toEqual([]);
    expect(remapCuesToPieces([cue(-500, 200)], pieces)).toEqual([]);
  });

  it('drops cues that remap to zero duration', () => {
    expect(remapCuesToPieces([cue(1_000, 1_000)], pieces)).toEqual([]);
  });
});

describe('concatWavPiecesToBuffer', () => {
  let dir: string;
  const makeWav = (samples: number[]): string => {
    // 16 kHz mono pcm_s16le, canonical 44-byte header + samples.
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    const path = join(dir, 'parent.wav');
    writeFileSync(path, Buffer.concat([header, data]));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'subcast-wavpack-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('concatenates piece ranges gaplessly with a consistent header', () => {
    // 3 s of audio: samples 0..29999. Pieces [0.0,1.0)s + [2.0,3.0)s.
    const samples = Array.from({ length: 48_000 }, (_, i) => (i % 100) - 50);
    const path = makeWav(samples);
    const { wav, durationSec } = concatWavPiecesToBuffer(path, [
      { absStartMs: 0, durMs: 1_000 },
      { absStartMs: 2_000, durMs: 1_000 },
    ]);
    expect(durationSec).toBe(2);
    const info = parseWavHeader(wav);
    expect(info).not.toBeNull();
    expect(info!.sampleRate).toBe(16_000);
    expect(info!.dataLength).toBe(2 * 16_000 * 2);
    // First data sample == parent sample 0; the 16_000th output sample
    // (start of piece 2) == parent sample 32_000 (t=2 s).
    const out0 = wav.readInt16LE(info!.dataOffset);
    const outPiece2 = wav.readInt16LE(info!.dataOffset + 16_000 * 2);
    expect(out0).toBe(samples[0]!);
    expect(outPiece2).toBe(samples[32_000]!);
  });

  it('matches the contiguous slice layout for a single piece', () => {
    const samples = Array.from({ length: 16_000 }, (_, i) => i % 7);
    const path = makeWav(samples);
    const { wav } = concatWavPiecesToBuffer(path, [
      { absStartMs: 250, durMs: 500 },
    ]);
    const info = parseWavHeader(wav);
    expect(info!.dataLength).toBe(Math.floor((0.5 * 32_000) / 2) * 2);
    // Piece starts at t = 0.25 s = parent sample 4000.
    expect(wav.readInt16LE(info!.dataOffset)).toBe(samples[4000]!);
    expect(wav.readInt16LE(info!.dataOffset + 2)).toBe(samples[4001]!);
  });

  it('throws on empty / fully-clamped pieces', () => {
    const path = makeWav([1, 2, 3]);
    expect(() =>
      concatWavPiecesToBuffer(path, [{ absStartMs: 0, durMs: 0 }]),
    ).toThrow(/WAV_SLICE_EMPTY/);
    expect(() => concatWavPiecesToBuffer(path, [])).toThrow(/WAV_SLICE_EMPTY/);
  });
});
