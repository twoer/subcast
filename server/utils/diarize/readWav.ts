/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Pure-JS WAV file reader (Q1, docs/diarization-plan.md v1.5).
 *
 * Why we don't use `sherpa.readWave`: Node 22+ enforces strict N-API
 * external-buffer rules; sherpa-onnx-node 1.13.2's readWave creates
 * external buffers via the deprecated napi_create_external_buffer API
 * and throws "External buffers are not allowed" inside Nitro's bundle.
 * Vitest tolerates it, but the production Nitro runtime doesn't.
 *
 * Rolling our own keeps the Float32Array fully JS-owned, which the
 * downstream native calls (sd.process / extractor.acceptWaveform) all
 * accept without complaint.
 *
 * Format scope: we only need to read what `extractWav` produces — a
 * 16 kHz mono 16-bit signed-little-endian PCM WAV. The reader rejects
 * anything else loudly so a misconfigured ffmpeg upstream doesn't
 * silently corrupt diarization.
 */

import { readFile } from 'node:fs/promises';

export interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Read a WAV file from disk and return PCM samples as a JS-owned
 * Float32Array in [-1, 1]. Throws on any format mismatch — caller
 * should be passing in something extractWav wrote.
 */
export async function readWavF32(path: string): Promise<Wave> {
  const buf = await readFile(path);
  return parseWavF32(buf);
}

/**
 * Pure parser exported for unit testing. Same contract as readWavF32
 * but starts from a Buffer instead of a file path.
 */
export function parseWavF32(buf: Buffer): Wave {
  if (buf.length < 44) {
    throw new Error(`wav too short: ${buf.length} bytes (need at least 44 for RIFF header)`);
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('wav: not a RIFF/WAVE file');
  }

  // Walk chunks. fmt and data are the two we need; ignore any others.
  let pos = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataStart = -1;
  let dataLen = -1;

  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const bodyStart = pos + 8;

    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(bodyStart);
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (id === 'data') {
      dataStart = bodyStart;
      dataLen = size;
      break;
    }
    pos = bodyStart + size;
    // Chunks are 2-byte aligned.
    if (size & 1) pos += 1;
  }

  if (dataStart < 0) throw new Error('wav: no data chunk');
  if (audioFormat !== 1) {
    throw new Error(`wav: only PCM (format 1) supported, got format ${audioFormat}`);
  }
  if (numChannels !== 1) {
    throw new Error(`wav: only mono supported, got ${numChannels} channels`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`wav: only 16-bit supported, got ${bitsPerSample}-bit`);
  }

  const sampleCount = Math.floor(dataLen / 2);
  // Allocate a fresh JS-owned Float32Array (NOT a view over the file
  // buffer). The native bindings reject views of externally-allocated
  // memory in Node 22 strict mode.
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const offset = dataStart + i * 2;
    const s = buf.readInt16LE(offset);
    samples[i] = s / 32768;
  }
  return { samples, sampleRate };
}
