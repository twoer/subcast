/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { describe, expect, it, vi } from 'vitest';
import { pullQwenModel, type QwenPullProgress } from '../qwen';

/**
 * Build a fake Response whose body streams a fixed string in user-chosen
 * chunks. Splitting the NDJSON payload mid-line is the interesting case —
 * the parser has to buffer the trailing fragment until the next chunk.
 */
function fakeStreamingResponse(text: string, chunks: number): Response {
  const encoder = new TextEncoder();
  const chunkSize = Math.ceil(text.length / chunks);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function fakeFetchReturning(response: Response): typeof globalThis.fetch {
  return (async () => response) as typeof globalThis.fetch;
}

describe('pullQwenModel', () => {
  it('parses NDJSON progress lines and resolves on success', async () => {
    const ndjson = [
      '{"status":"pulling manifest"}',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":500}',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":1000}',
      '{"status":"verifying sha256 digest"}',
      '{"status":"success"}',
      '',
    ].join('\n');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchReturning(fakeStreamingResponse(ndjson, 4));
    const progress: QwenPullProgress[] = [];
    try {
      await pullQwenModel({
        variant: '7b',
        onProgress: (p) => progress.push(p),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(progress.map((p) => p.status)).toEqual([
      'pulling manifest',
      'downloading',
      'downloading',
      'verifying sha256 digest',
      'success',
    ]);
    expect(progress[1]!.completed).toBe(500);
    expect(progress[2]!.completed).toBe(1000);
  });

  it('throws when Ollama emits an `error` line', async () => {
    const ndjson = '{"status":"pulling manifest"}\n{"error":"no space left"}\n';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchReturning(fakeStreamingResponse(ndjson, 1));
    try {
      await expect(pullQwenModel({ variant: '3b' })).rejects.toThrow('no space left');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when stream closes without a success line', async () => {
    const ndjson = '{"status":"pulling manifest"}\n';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchReturning(fakeStreamingResponse(ndjson, 1));
    try {
      await expect(pullQwenModel({ variant: '3b' })).rejects.toThrow(/success/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ignores malformed lines gracefully', async () => {
    const ndjson = '{"status":"pulling manifest"}\nnot-json\n{"status":"success"}\n';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchReturning(fakeStreamingResponse(ndjson, 2));
    const onProgress = vi.fn();
    try {
      await pullQwenModel({ variant: '7b', onProgress });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
