/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { probeUrlThroughput, pickFastestUrl } from '../downloadRace';

/**
 * Build a fake fetch that emits `chunkBytes` every `chunkIntervalMs` for
 * up to `totalChunks` chunks, then closes. Honors AbortSignal.
 */
function makeFetch(opts: {
  chunkBytes: number;
  chunkIntervalMs: number;
  totalChunks: number;
  status?: number;
}) {
  const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
    const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        if (emitted >= opts.totalChunks) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, opts.chunkIntervalMs));
        if (signal?.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'));
          return;
        }
        controller.enqueue(new Uint8Array(opts.chunkBytes));
        emitted++;
      },
    });
    return new Response(stream, {
      status: opts.status ?? 206,
      headers: { 'content-length': String(opts.chunkBytes * opts.totalChunks) },
    });
  };
  return fetchImpl;
}

describe('probeUrlThroughput', () => {
  it('returns bytes/sec for a steady stream', async () => {
    // 1 MB/s: 64KB every 64ms ≈ 1 MB/s. Probe 1s for test speed.
    const fetchImpl = makeFetch({ chunkBytes: 65_536, chunkIntervalMs: 64, totalChunks: 100 });
    const rate = await probeUrlThroughput('https://example.test/foo', {
      fetchImpl,
      probeMs: 1000,
      minBytes: 64 * 1024,
    });
    // Expect close to 1 MB/s. Wide tolerance — CI noise.
    expect(rate).toBeGreaterThan(500_000);
    expect(rate).toBeLessThan(2_000_000);
  });

  it('returns 0 when the source delivers under the byte threshold', async () => {
    // Tiny dribble: 1KB every 200ms → 5KB/s. Over 1s = 5KB << 64KB threshold.
    const fetchImpl = makeFetch({ chunkBytes: 1024, chunkIntervalMs: 200, totalChunks: 100 });
    const rate = await probeUrlThroughput('https://example.test/slow', {
      fetchImpl,
      probeMs: 1000,
      minBytes: 64 * 1024,
    });
    expect(rate).toBe(0);
  });

  it('rejects when the response is not 200 or 206', async () => {
    const fetchImpl = makeFetch({ chunkBytes: 1024, chunkIntervalMs: 10, totalChunks: 1, status: 404 });
    await expect(
      probeUrlThroughput('https://example.test/missing', { fetchImpl, probeMs: 500 }),
    ).rejects.toThrow();
  });
});

describe('pickFastestUrl', () => {
  it('returns the URL with the highest measured throughput', async () => {
    const fastFetch = makeFetch({ chunkBytes: 65_536, chunkIntervalMs: 32, totalChunks: 100 });
    const slowFetch = makeFetch({ chunkBytes: 65_536, chunkIntervalMs: 256, totalChunks: 100 });
    const fetchImpl: typeof globalThis.fetch = (url, init) =>
      String(url).includes('fast') ? fastFetch(url, init) : slowFetch(url, init);

    const winner = await pickFastestUrl(
      ['https://slow.test/m', 'https://fast.test/m'],
      { fetchImpl, probeMs: 1000, minBytes: 64 * 1024 },
    );
    expect(winner).toBe('https://fast.test/m');
  });

  it('falls back to a working URL when one source fails', async () => {
    const goodFetch = makeFetch({ chunkBytes: 65_536, chunkIntervalMs: 32, totalChunks: 100 });
    const brokenFetch = makeFetch({ chunkBytes: 1, chunkIntervalMs: 1, totalChunks: 1, status: 404 });
    const fetchImpl: typeof globalThis.fetch = (url, init) =>
      String(url).includes('alive') ? goodFetch(url, init) : brokenFetch(url, init);

    const winner = await pickFastestUrl(
      ['https://failing.test/m', 'https://alive.test/m'],
      { fetchImpl, probeMs: 1000, minBytes: 64 * 1024 },
    );
    expect(winner).toBe('https://alive.test/m');
  });

  it('throws when every source fails', async () => {
    const fetchImpl = makeFetch({ chunkBytes: 1, chunkIntervalMs: 1, totalChunks: 1, status: 500 });
    await expect(
      pickFastestUrl(['https://a.test/m', 'https://b.test/m'], { fetchImpl, probeMs: 500 }),
    ).rejects.toThrow();
  });
});
