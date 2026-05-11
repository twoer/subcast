import { describe, it, expect, vi } from 'vitest';
import { StreamPipeline, DEFAULT_STREAM_CONFIG } from '../stream-pipeline';

vi.mock('../whisper', () => ({
  transcribeChunk: vi.fn().mockResolvedValue([
    { startMs: 0, endMs: 3000, text: 'hello world' },
  ]),
}));

vi.mock('../db', () => ({
  SUBCAST_PATHS: { tmp: '/tmp/subcast-test' },
}));

vi.mock('../log', () => ({
  logEvent: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

describe('StreamPipeline', () => {
  const BYTES_PER_SEC = 16000 * 2;

  function createPipeline(chunkSec = 10) {
    const sent: Record<string, unknown>[] = [];
    const send = (data: Record<string, unknown>) => sent.push(data);
    const pipeline = new StreamPipeline(
      { chunkSec, model: 'base' },
      send,
    );
    return { pipeline, sent };
  }

  it('accumulates audio until chunk threshold is reached', () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.appendAudio(Buffer.alloc(16000));
    expect(sent.length).toBe(0);
  });

  it('dispatches a chunk when threshold is reached', async () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.appendAudio(Buffer.alloc(32000));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));
    expect(sent[0]).toMatchObject({ type: 'status', state: 'processing', chunkIdx: 0 });
  });

  it('carries remainder bytes to next chunk', async () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.appendAudio(Buffer.alloc(48000));
    await vi.waitFor(() => expect(sent.some((s) => s.type === 'transcript')).toBe(true));
  });

  it('flush sends remaining buffered audio as a chunk', async () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.appendAudio(Buffer.alloc(16000));
    pipeline.flush();
    await vi.waitFor(() => expect(sent.some((s) => s.type === 'transcript')).toBe(true));
  });

  it('abort prevents further processing', () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.abort();
    pipeline.appendAudio(Buffer.alloc(32000));
    expect(sent.length).toBe(0);
    expect(pipeline.isActive).toBe(false);
  });

  it('send receives transcript with correct chunkStartMs', async () => {
    const { pipeline, sent } = createPipeline(2);
    pipeline.appendAudio(Buffer.alloc(64000));
    await vi.waitFor(() => expect(sent.some((s) => s.type === 'transcript')).toBe(true));
    const transcript = sent.find((s) => s.type === 'transcript')!;
    expect(transcript.chunkStartMs).toBe(0);
  });
});
