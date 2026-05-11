import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { transcribeChunk, type TranscribeOptions } from './whisper';
import type { Cue } from './vtt';

export interface StreamCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface StreamConfig {
  chunkSec: number;
  model: string;
}

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  chunkSec: 10,
  model: 'base',
};

/** 16kHz mono s16le = 32000 bytes per second */
const BYTES_PER_SEC = 16000 * 2;

/** Write a minimal WAV header + PCM data to a Buffer. */
function pcmToWavBuffer(pcm: Buffer): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(16000, 24);     // sample rate
  header.writeUInt32LE(32000, 28);     // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export type SendFn = (data: Record<string, unknown>) => void;

export class StreamPipeline {
  private pcmBuffers: Buffer[] = [];
  private pcmByteLength = 0;
  private config: StreamConfig;
  private send: SendFn;
  private chunkIdx = 0;
  private tmpId = randomUUID();
  private aborted = false;

  constructor(config: StreamConfig, send: SendFn) {
    this.config = config;
    this.send = send;
  }

  get isActive(): boolean {
    return !this.aborted;
  }

  appendAudio(pcm: Buffer): void {
    if (this.aborted) return;
    this.pcmBuffers.push(pcm);
    this.pcmByteLength += pcm.length;
    const targetBytes = this.config.chunkSec * BYTES_PER_SEC;
    if (this.pcmByteLength >= targetBytes) {
      const combined = Buffer.concat(this.pcmBuffers);
      const chunk = combined.subarray(0, targetBytes);
      const remainder = combined.subarray(targetBytes);
      this.pcmBuffers = remainder.length > 0 ? [Buffer.from(remainder)] : [];
      this.pcmByteLength = remainder.length;
      this.dispatchChunk(chunk);
    }
  }

  flush(): void {
    if (this.pcmByteLength === 0) return;
    const combined = Buffer.concat(this.pcmBuffers);
    this.pcmBuffers = [];
    this.pcmByteLength = 0;
    this.dispatchChunk(combined);
  }

  abort(): void {
    this.aborted = true;
  }

  private dispatchChunk(pcm: Buffer): void {
    if (this.aborted) return;
    const idx = this.chunkIdx++;
    this.processChunk(pcm, idx).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent({ level: 'error', event: 'stream_chunk_error', chunkIdx: idx, error: msg });
      this.send({
        type: 'error',
        code: 'CHUNK_FAILED',
        msg: `Chunk ${idx} failed: ${msg}`,
      });
    });
  }

  private async processChunk(pcm: Buffer, idx: number): Promise<void> {
    if (this.aborted) return;
    this.send({ type: 'status', state: 'processing', chunkIdx: idx });

    const wav = pcmToWavBuffer(pcm);
    const wavPath = join(SUBCAST_PATHS.tmp, `stream-${this.tmpId}-${idx}.wav`);
    try {
      await mkdir(SUBCAST_PATHS.tmp, { recursive: true });
      await writeFile(wavPath, wav);
      const durationSec = pcm.length / BYTES_PER_SEC;
      const cues = await transcribeChunk(
        wavPath,
        0,
        durationSec,
        durationSec,
        { model: this.config.model as TranscribeOptions['model'] },
      );
      const streamCues: StreamCue[] = cues.map((c: Cue) => ({
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text,
      }));
      this.send({
        type: 'transcript',
        chunkIdx: idx,
        chunkStartMs: idx * this.config.chunkSec * 1000,
        cues: streamCues,
      });
      logEvent({ level: 'info', event: 'stream_chunk_done', chunkIdx: idx, cues: streamCues.length });
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  }
}
