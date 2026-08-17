/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const { tmpRoot, llmCalls } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-insights-'));
  process.env.SUBCAST_HOME = r;
  return {
    tmpRoot: r,
    llmCalls: [] as Array<{ kind: 'chat' | 'chatStream'; modelId?: string }>,
  };
});

vi.mock('../llmClient', () => {
  // Deterministic stub backend: yields the same canned markdown the
  // previous Ollama mock did, but through the new LLMBackend interface.
  const stub = {
    async chat(opts?: { responseSchema?: unknown; modelId?: string }) {
      llmCalls.push({ kind: 'chat', modelId: opts?.modelId });
      if (opts?.responseSchema) {
        return {
          content: JSON.stringify({
            summary: 'Partial window summary.',
            summaryBullets: ['Partial point'],
            chapters: [{ startMs: 0, title: 'Partial', description: 'Window' }],
          }),
          finishReason: 'stop',
          usage: {},
          timing: { totalMs: 1 },
          retries: 0,
          coldStart: false,
        };
      }
      return {
        content: '## Summary\n\nMock summary text.\n\n## Chapters\n\n- [00:00:00] Intro — start\n',
        finishReason: 'stop',
        usage: {},
        timing: { totalMs: 1 },
        retries: 0,
        coldStart: false,
      };
    },
    async *chatStream(opts?: { modelId?: string }) {
      llmCalls.push({ kind: 'chatStream', modelId: opts?.modelId });
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
import { saveSettings } from '../settings';
import { buildInsightArtifactFingerprint } from '../artifactFingerprint';
import { readLatestInsightArtifact } from '../artifactStore';
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

beforeEach(() => {
  llmCalls.length = 0;
  saveSettings({ llmModel: '8b' });
  getDb().prepare(`DELETE FROM insight_tasks`).run();
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world.\n',
  );
  rmSync(join(SUBCAST_PATHS.cache, HASH, 'insights.json'), { force: true });
  rmSync(join(SUBCAST_PATHS.cache, HASH, 'artifacts'), { recursive: true, force: true });
  rmSync(join(SUBCAST_PATHS.cache, HASH, 'insights.json.raw.txt'), { force: true });
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

    const start = JSON.parse(events[0]!.data);
    expect(start.model).toBe('8b');
    const transcript = readFileSync(join(SUBCAST_PATHS.cache, HASH, 'original.vtt'), 'utf8');
    const artifactFingerprint = buildInsightArtifactFingerprint({
      videoSha: HASH,
      transcript,
      uiLanguage: 'en',
      modelId: '8b',
    });
    const written = readLatestInsightArtifact(HASH, 'en', artifactFingerprint)?.payload as {
      _meta: Record<string, unknown>;
    };
    expect(llmCalls).toEqual([expect.objectContaining({ kind: 'chatStream', modelId: '8b' })]);
    expect(written._meta.modelId).toBe('8b');
    expect(written._meta.ollamaModel).toBeUndefined();
    expect(written._meta.rawMarkdown).toBeUndefined();
    expect(written._meta.artifactFingerprint).toBe(artifactFingerprint);
  });

  it('uses map/reduce progress frames for long transcripts instead of rejecting by prompt length', async () => {
    const longTranscript = [
      'WEBVTT',
      '',
      ...Array.from({ length: 900 }, (_, i) => [
        `00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 --> 00:${String(Math.floor((i + 1) / 60)).padStart(2, '0')}:${String((i + 1) % 60).padStart(2, '0')}.000`,
        `This is a deliberately long transcript line ${i}. ${'context '.repeat(24)}`,
      ].join('\n')),
    ].join('\n\n');
    writeFileSync(join(SUBCAST_PATHS.cache, HASH, 'original.vtt'), longTranscript);

    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: HASH }, events);
    await handler(event);

    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('phase');
    expect(kinds).toContain('progress');
    expect(kinds).not.toContain('token');
    expect(events.map((e) => e.data).join('\n')).not.toContain('VIDEO_TOO_LONG');

    const done = JSON.parse(events[events.length - 1]!.data);
    expect(done.insights.summary).toContain('Mock summary');
    expect(llmCalls.length).toBeGreaterThan(1);
    expect(llmCalls.every((call) => call.kind === 'chat' && call.modelId === '8b')).toBe(true);
  });

  it('ignores legacy ollama_model when choosing the Insight model', async () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('ollama_model', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run('qwen2.5:7b');
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: HASH }, events);
    await handler(event);

    const start = JSON.parse(events[0]!.data);
    expect(start.model).toBe('8b');
  });

  it('emits MODEL_NOT_CONFIGURED when no LLM model is configured', async () => {
    saveSettings({ llmModel: undefined });
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: HASH }, events);
    await handler(event);

    expect(events).toEqual([
      expect.objectContaining({
        event: 'error',
        data: expect.stringContaining('MODEL_NOT_CONFIGURED'),
      }),
    ]);
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM insight_tasks`)
      .get() as { n: number };
    expect(count.n).toBe(0);
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
