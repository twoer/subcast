/* SPDX-License-Identifier: Apache-2.0 */

/**
 * In-memory PCM WAV slicing.
 *
 * The whisper path transcribes chunk-by-chunk (SSE progress + resume),
 * and historically produced each 30 s chunk slice by spawning ffmpeg.
 * The parent WAV is a plain 16 kHz mono pcm_s16le file we produced
 * ourselves (extractWav) — slicing it is a byte-range copy, so we keep
 * the parent buffer cached per task and write chunk slices from memory,
 * removing one process spawn per chunk. ffmpeg stays as the fallback
 * for anything this parser refuses (non-PCM layouts, odd chunk graphs).
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Byte offset of the data chunk payload inside the file. */
  dataOffset: number;
  /** Usable data bytes (chunk size clamped to actual file length). */
  dataLength: number;
}

/**
 * Parse a RIFF/WAVE header. Walks the chunk list (rather than assuming
 * the canonical 44-byte layout) to survive LIST/junk chunks ffmpeg or
 * other tools may insert. Returns null for anything unparseable.
 */
export function parseWavHeader(buf: Buffer): WavInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: Pick<WavInfo, 'audioFormat' | 'channels' | 'sampleRate' | 'bitsPerSample'> | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (off + 8 + 16 > buf.length) return null;
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 8 + 2),
        sampleRate: buf.readUInt32LE(off + 8 + 4),
        bitsPerSample: buf.readUInt16LE(off + 8 + 14),
      };
    } else if (id === 'data') {
      dataOffset = off + 8;
      dataLength = Math.min(size, buf.length - dataOffset);
      break;
    }
    // RIFF chunks are word-aligned; odd sizes carry one pad byte.
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) return null;
  return { ...fmt, dataOffset, dataLength };
}

function canonicalHeader(info: WavInfo, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(info.audioFormat, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

interface ParentEntry {
  path: string;
  mtimeMs: number;
  buf: Buffer;
  info: WavInfo;
}

/** Single-entry parent cache — the transcribe queue is single-concurrent. */
let parentCache: ParentEntry | null = null;

/** Drop the cached parent WAV. Called when a transcribe task ends. */
export function releaseWavSliceCache(): void {
  parentCache = null;
}

export interface SliceResult {
  durationSec: number;
}

/**
 * Slice [startSec, endSec) into a standalone in-memory WAV buffer
 * (shared by the whisper-server HTTP path, which posts the bytes
 * directly, and `sliceWavInMemory`, which writes them to disk).
 * Throws on layouts this module refuses (non-PCM, unparseable headers,
 * empty ranges) — callers fall back to the ffmpeg slice path.
 */
export function sliceWavToBuffer(
  srcPath: string,
  startSec: number,
  endSec: number,
): { wav: Buffer } & SliceResult {
  const mtimeMs = statSync(srcPath).mtimeMs;
  let entry = parentCache;
  if (!entry || entry.path !== srcPath || entry.mtimeMs !== mtimeMs) {
    const buf = readFileSync(srcPath);
    const info = parseWavHeader(buf);
    if (!info) throw new Error('WAV_SLICE_UNPARSEABLE');
    if (info.audioFormat !== 1) {
      throw new Error(`WAV_SLICE_NOT_PCM:${info.audioFormat}`);
    }
    entry = { path: srcPath, mtimeMs, buf, info };
    parentCache = entry;
  }

  const { buf, info } = entry;
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  if (blockAlign <= 0) throw new Error('WAV_SLICE_BAD_BLOCK_ALIGN');
  const byteRate = info.sampleRate * blockAlign;
  const dataStart = info.dataOffset;
  const startAligned =
    dataStart +
    Math.floor(Math.min(Math.max(startSec, 0) * byteRate, info.dataLength) / blockAlign) * blockAlign;
  const endAligned =
    dataStart +
    Math.floor(Math.min(Math.max(endSec, 0) * byteRate, info.dataLength) / blockAlign) * blockAlign;
  if (endAligned <= startAligned) {
    throw new Error(`WAV_SLICE_EMPTY:${startSec}-${endSec}`);
  }
  const dataLength = endAligned - startAligned;
  const out = Buffer.alloc(44 + dataLength);
  canonicalHeader(info, dataLength).copy(out, 0);
  buf.copy(out, 44, startAligned, endAligned);
  return { wav: out, durationSec: dataLength / byteRate };
}

/** File-writing variant of `sliceWavToBuffer` (whisper-cli fallback path). */
export function sliceWavInMemory(
  srcPath: string,
  dstPath: string,
  startSec: number,
  endSec: number,
): SliceResult {
  const { wav, durationSec } = sliceWavToBuffer(srcPath, startSec, endSec);
  writeFileSync(dstPath, wav);
  return { durationSec };
}

/**
 * Concatenate several absolute time ranges of the parent WAV into one
 * standalone in-memory WAV buffer (the packed-whisper-chunk slice).
 * Gaps between ranges are physically excluded, so request-local
 * timestamps must be remapped via the piece list (see
 * `remapCuesToPieces`). Same refusal contract as `sliceWavToBuffer`.
 */
export function concatWavPiecesToBuffer(
  srcPath: string,
  pieces: ReadonlyArray<{ absStartMs: number; durMs: number }>,
): { wav: Buffer; durationSec: number } {
  const mtimeMs = statSync(srcPath).mtimeMs;
  let entry = parentCache;
  if (!entry || entry.path !== srcPath || entry.mtimeMs !== mtimeMs) {
    const buf = readFileSync(srcPath);
    const info = parseWavHeader(buf);
    if (!info) throw new Error('WAV_SLICE_UNPARSEABLE');
    if (info.audioFormat !== 1) {
      throw new Error(`WAV_SLICE_NOT_PCM:${info.audioFormat}`);
    }
    entry = { path: srcPath, mtimeMs, buf, info };
    parentCache = entry;
  }

  const { buf, info } = entry;
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  if (blockAlign <= 0) throw new Error('WAV_SLICE_BAD_BLOCK_ALIGN');
  const byteRate = info.sampleRate * blockAlign;
  // Byte-accurate ranges, block-aligned at both ends like the single
  // slice path. Zero/negative pieces (sub-ms rounding) drop out here.
  const ranges: Array<[start: number, end: number]> = [];
  for (const p of pieces) {
    const startAligned =
      info.dataOffset +
      Math.floor(
        Math.min(Math.max(p.absStartMs / 1000, 0) * byteRate, info.dataLength) / blockAlign,
      ) * blockAlign;
    const endAligned =
      info.dataOffset +
      Math.floor(
        Math.min(Math.max((p.absStartMs + p.durMs) / 1000, 0) * byteRate, info.dataLength) /
          blockAlign,
      ) * blockAlign;
    if (endAligned > startAligned) ranges.push([startAligned, endAligned]);
  }
  if (ranges.length === 0) throw new Error('WAV_SLICE_EMPTY:packed');
  const dataLength = ranges.reduce((s, [a, b]) => s + (b - a), 0);
  const out = Buffer.alloc(44 + dataLength);
  canonicalHeader(info, dataLength).copy(out, 0);
  let cursor = 44;
  for (const [a, b] of ranges) {
    buf.copy(out, cursor, a, b);
    cursor += b - a;
  }
  return { wav: out, durationSec: dataLength / byteRate };
}
