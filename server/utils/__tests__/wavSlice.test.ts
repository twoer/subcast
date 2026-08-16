/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWavHeader,
  releaseWavSliceCache,
  sliceWavInMemory,
} from '../wavSlice';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // mono 16-bit

/** Canonical 44-byte pcm_s16le mono WAV with `seconds` of silence. */
function makeWav(seconds: number, format = 1): Buffer {
  const dataLength = Math.round(seconds * BYTES_PER_SEC);
  const buf = Buffer.alloc(44 + dataLength);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(BYTES_PER_SEC, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLength, 40);
  // Distinct sample payloads so slices can be verified by content.
  for (let i = 0; i < dataLength / 2; i++) {
    buf.writeInt16LE((i % 1000) - 500, 44 + i * 2);
  }
  return buf;
}

describe('parseWavHeader', () => {
  it('reads fmt and data fields from a canonical WAV', () => {
    const info = parseWavHeader(makeWav(1));
    expect(info).toEqual({
      audioFormat: 1,
      channels: 1,
      sampleRate: SAMPLE_RATE,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: BYTES_PER_SEC,
    });
  });

  it('walks past non-canonical chunks to find fmt and data', () => {
    const canonical = makeWav(0.5);
    const fmtBody = canonical.subarray(20, 36); // 16-byte fmt payload
    const data = canonical.subarray(44);
    const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
    // junk chunk with odd size 3 → one pad byte; fmt with its real size.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      u32(4 + 12 + 24 + 8 + data.length),
      Buffer.from('WAVE', 'ascii'),
      Buffer.from('junk', 'ascii'),
      u32(3),
      Buffer.from([0x01, 0x02, 0x03, 0x00]), // payload + pad
      Buffer.from('fmt ', 'ascii'),
      u32(16),
      fmtBody,
      Buffer.from('data', 'ascii'),
      u32(data.length),
      data,
    ]);
    const info = parseWavHeader(wav);
    expect(info?.sampleRate).toBe(SAMPLE_RATE);
    expect(info?.bitsPerSample).toBe(16);
    expect(info?.dataOffset).toBe(12 + 12 + 24 + 8);
    expect(info?.dataLength).toBe(data.length);
  });

  it('returns null for non-RIFF and truncated inputs', () => {
    expect(parseWavHeader(Buffer.alloc(10))).toBeNull();
    expect(parseWavHeader(Buffer.from('NOTAWAVEFILE....'))).toBeNull();
  });
});

describe('sliceWavInMemory', () => {
  let dir: string;
  let srcPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'subcast-wavslice-'));
    srcPath = join(dir, 'parent.wav');
    writeFileSync(srcPath, makeWav(1));
  });

  afterEach(() => {
    releaseWavSliceCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a standalone WAV covering exactly the requested range', () => {
    const dstPath = join(dir, 'chunk.wav');
    const { durationSec } = sliceWavInMemory(srcPath, dstPath, 0.25, 0.75);

    expect(durationSec).toBeCloseTo(0.5, 6);
    const out = readFileSync(dstPath);
    const info = parseWavHeader(out);
    expect(info?.sampleRate).toBe(SAMPLE_RATE);
    expect(info?.bitsPerSample).toBe(16);
    expect(info?.dataLength).toBe(Math.round(0.5 * BYTES_PER_SEC));
    // Content must be the parent's bytes for [0.25s, 0.75s), not silence.
    const parent = makeWav(1);
    expect(out.subarray(44)).toEqual(parent.subarray(44 + 8000, 44 + 24000));
  });

  it('clamps the range to the available data', () => {
    const dstPath = join(dir, 'tail.wav');
    const { durationSec } = sliceWavInMemory(srcPath, dstPath, 0.9, 5);
    expect(durationSec).toBeCloseTo(0.1, 6);
  });

  it('throws on empty ranges and non-PCM layouts', () => {
    const dstPath = join(dir, 'x.wav');
    expect(() => sliceWavInMemory(srcPath, dstPath, 2, 3)).toThrow(/WAV_SLICE_EMPTY/);

    const floatPath = join(dir, 'float.wav');
    writeFileSync(floatPath, makeWav(1, 3)); // IEEE float
    expect(() => sliceWavInMemory(floatPath, dstPath, 0, 0.5)).toThrow(/WAV_SLICE_NOT_PCM/);
    // After the non-PCM refusal the float parent must NOT be cached.
    writeFileSync(floatPath, makeWav(1));
    expect(() => sliceWavInMemory(floatPath, dstPath, 0, 0.5)).not.toThrow();
  });
});
