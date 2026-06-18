/* SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, HashMismatchError } from '../downloader';

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a stubbed `fetch` that yields fixed bytes split into chunks, with an
 * optional `expectRange` assertion that records what Range header the
 * caller sent on each invocation.
 */
function fakeFetch(opts: {
  fullBody: Uint8Array;
  /** Per-call: when this header is sent, slice the body and return 206. */
  honorRange?: boolean;
  /** Chunk size for streaming. */
  chunkSize?: number;
  /** Captured Range header per call (push). */
  rangesSeen?: string[];
}): typeof globalThis.fetch {
  const chunkSize = opts.chunkSize ?? 8;
  return (async (_url: RequestInfo, init?: RequestInit): Promise<Response> => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
    opts.rangesSeen?.push(range);

    let body = opts.fullBody;
    let status = 200;
    if (range && opts.honorRange) {
      const m = /^bytes=(\d+)-/.exec(range);
      if (m) {
        body = opts.fullBody.slice(Number(m[1]));
        status = 206;
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += chunkSize) {
          controller.enqueue(body.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof globalThis.fetch;
}

function responseFromBytes(body: Uint8Array, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    statusText: status >= 500 ? 'Server Error' : 'OK',
    headers: { 'content-length': String(body.length) },
  });
}

describe('downloadFile', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'subcast-dl-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('downloads a fresh file, returns correct SHA256', async () => {
    const body = Buffer.from('hello subcast world');
    const dest = join(tmp, 'a.bin');

    const result = await downloadFile({
      url: 'https://example/a.bin',
      destPath: dest,
      fetchImpl: fakeFetch({ fullBody: body }),
    });

    expect(result.bytesDownloaded).toBe(body.length);
    expect(result.sha256).toBe(sha256(body));
    expect(result.resumed).toBe(false);
    expect(await readFile(dest)).toEqual(body);
  });

  it('resumes from a partial file when the server honors Range', async () => {
    const body = Buffer.from('0123456789abcdef0123456789abcdef'); // 32 bytes
    const dest = join(tmp, 'b.bin');
    await writeFile(dest, body.slice(0, 12)); // simulate 12-byte partial

    const ranges: string[] = [];
    const result = await downloadFile({
      url: 'https://example/b.bin',
      destPath: dest,
      expectedSha256: sha256(body),
      fetchImpl: fakeFetch({ fullBody: body, honorRange: true, rangesSeen: ranges }),
    });

    expect(ranges).toEqual(['bytes=12-']);
    expect(result.resumed).toBe(true);
    expect(result.bytesDownloaded).toBe(body.length);
    expect(await readFile(dest)).toEqual(body);
  });

  it('restarts from scratch when the server ignores Range and replies 200', async () => {
    const body = Buffer.from('xxxxyyyyzzzzwwww'); // 16 bytes
    const dest = join(tmp, 'c.bin');
    await writeFile(dest, Buffer.from('STALE-PREFIX'));

    const result = await downloadFile({
      url: 'https://example/c.bin',
      destPath: dest,
      fetchImpl: fakeFetch({ fullBody: body, honorRange: false }),
    });

    // Even though we sent a Range header, the server returned 200 — we should
    // have truncated and rewritten the whole body, not appended.
    expect(result.bytesDownloaded).toBe(body.length);
    expect(await readFile(dest)).toEqual(body);
    expect(result.resumed).toBe(false);
  });

  it('verifies SHA256 and retries on mismatch, eventually throwing', async () => {
    // Stub yields a body whose hash will NEVER match expectedSha256.
    const body = Buffer.from('corrupt body');
    const dest = join(tmp, 'd.bin');
    const ranges: string[] = [];

    await expect(
      downloadFile({
        url: 'https://example/d.bin',
        destPath: dest,
        expectedSha256: 'deadbeef'.repeat(8),
        maxHashRetries: 1,
        fetchImpl: fakeFetch({ fullBody: body, honorRange: true, rangesSeen: ranges }),
      }),
    ).rejects.toBeInstanceOf(HashMismatchError);

    // Two attempts total (initial + 1 retry). Both should have started
    // fresh because the previous attempt's mismatch deletes the partial.
    expect(ranges).toEqual(['', '']);
  });

  it('retries transient HTTP failures and then succeeds', async () => {
    const body = Buffer.from('eventual success');
    const dest = join(tmp, 'retry-http.bin');
    let calls = 0;

    const result = await downloadFile({
      url: 'https://example/retry-http.bin',
      destPath: dest,
      retryDelayMs: 1,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' });
        }
        return responseFromBytes(body);
      }) as typeof globalThis.fetch,
    });

    expect(calls).toBe(2);
    expect(result.sha256).toBe(sha256(body));
    expect(await readFile(dest)).toEqual(body);
  });

  it('retries network errors and resumes the partial file', async () => {
    const body = Buffer.from('0123456789abcdef');
    const dest = join(tmp, 'retry-network.bin');
    await writeFile(dest, body.slice(0, 8));
    const ranges: string[] = [];
    let calls = 0;

    const result = await downloadFile({
      url: 'https://example/retry-network.bin',
      destPath: dest,
      retryDelayMs: 1,
      fetchImpl: (async (_url: RequestInfo, init?: RequestInit) => {
        calls += 1;
        ranges.push((init?.headers as Record<string, string> | undefined)?.Range ?? '');
        if (calls === 1) {
          throw new Error('socket closed');
        }
        return responseFromBytes(body.slice(8), 206);
      }) as typeof globalThis.fetch,
    });

    expect(calls).toBe(2);
    expect(ranges).toEqual(['bytes=8-', 'bytes=8-']);
    expect(result.resumed).toBe(true);
    expect(await readFile(dest)).toEqual(body);
  });

  it('does not retry user cancellation', async () => {
    const dest = join(tmp, 'abort.bin');
    const ctrl = new AbortController();
    let calls = 0;

    await expect(
      downloadFile({
        url: 'https://example/abort.bin',
        destPath: dest,
        signal: ctrl.signal,
        retryDelayMs: 1,
        fetchImpl: (async () => {
          calls += 1;
          ctrl.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        }) as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls).toBe(1);
  });

  it('fires throttled progress callbacks', async () => {
    const body = Buffer.alloc(200, 7);
    const dest = join(tmp, 'e.bin');
    const ticks: number[] = [];

    await downloadFile({
      url: 'https://example/e.bin',
      destPath: dest,
      progressIntervalMs: 1, // basically every chunk
      onProgress: (p) => ticks.push(p.bytesDownloaded),
      fetchImpl: fakeFetch({ fullBody: body, chunkSize: 25 }),
    });

    // We expect at least one tick and ticks should be monotonically
    // non-decreasing, ending at-or-below body.length (final tick may not
    // fire if pipeline finishes within the throttle window).
    expect(ticks.length).toBeGreaterThan(0);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!).toBeGreaterThanOrEqual(ticks[i - 1]!);
    }
    expect(ticks.at(-1)!).toBeLessThanOrEqual(body.length);
  });
});
