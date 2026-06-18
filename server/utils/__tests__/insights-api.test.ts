/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-insights-'));
  process.env.SUBCAST_HOME = r;
  return { tmpRoot: r };
});

vi.mock('../llmClient', () => {
  // Deterministic stub backend: yields the same canned markdown the
  // previous Ollama mock did, but through the new LLMBackend interface.
  const stub = {
    async chat() {
      return '## Summary\n\nMock summary text.\n\n## Chapters\n\n- [00:00:00] Intro — start\n';
    },
    async *chatStream() {
      yield { delta: '## Summary\n\n' };
      yield { delta: 'Mock summary text.\n\n' };
      yield { delta: '- Point A\n- Point B\n\n' };
      yield { delta: '## Chapters\n\n- [00:00:00] Intro — start\n' };
      yield { delta: '', finishReason: 'stop' as const };
    },
  };
  return {
    llmBackend: () => stub,
    createLLMBackend: () => stub,
  };
});

/* eslint-disable import/first -- vi.hoisted + vi.mock must precede imports */
import { join } from 'node:path';
import handler from '../../api/insights.get';
import { getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const HASH = 'b'.repeat(64);

function makeEvent(query: Record<string, string>, sentEvents: Array<{ event?: string; data: string }>) {
  const url = '/api/insights?' + new URLSearchParams(query).toString();
  let buffer = '';
  return {
    path: url,
    node: {
      req: { url, method: 'GET', headers: { 'accept-language': 'en' }, on: () => {} },
      res: {
        setHeader: () => {},
        getHeader: () => undefined,
        getHeaderNames: () => [],
        hasHeader: () => false,
        write: (chunk: string) => {
          buffer += chunk;
          let i: number;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const ev = /event: (\w+)/.exec(frame)?.[1];
            const data = /data: (.+)/.exec(frame)?.[1];
            if (data) sentEvents.push({ event: ev, data });
          }
          return true;
        },
        end: () => {},
      },
    },
    context: {},
    _handled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeAll(() => {
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world.\n',
  );
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'Clip.mp4', '.mp4', 0, Date.now(), Date.now());
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/api/insights SSE', () => {
  it('streams start → done with parsed insights (queue-based flow)', async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: HASH }, events);
    await handler(event);

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('start');
    expect(kinds[kinds.length - 1]).toBe('done');
    expect(kinds.filter((k) => k === 'token').length).toBeGreaterThan(0);

    const done = JSON.parse(events[events.length - 1]!.data);
    expect(done.insights.summary).toContain('Mock summary');
    expect(done.insights.chapters.length).toBeGreaterThanOrEqual(0);
  });

  it('400 on bad hash', async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: 'bad' }, events);
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404 on unknown video', async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: 'c'.repeat(64) }, events);
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 });
  });
});
