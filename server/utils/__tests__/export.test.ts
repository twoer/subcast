/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import JSZip from 'jszip';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-export-'));
  process.env.SUBCAST_HOME = r;
  return { tmpRoot: r };
});

/* eslint-disable import/first -- imports must follow vi.hoisted() so SUBCAST_HOME is set first */
import { join } from 'node:path';
import handler from '../../api/export.get';
import { getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const HASH = 'a'.repeat(64);

function makeEvent(query: Record<string, string>) {
  const url = '/api/export?' + new URLSearchParams(query).toString();
  return {
    path: url,
    node: {
      req: { url, method: 'GET', headers: {} },
      res: {
        setHeader: () => {},
        getHeader: () => undefined,
        getHeaderNames: () => [],
        hasHeader: () => false,
        end: () => {},
        write: () => true,
      },
    },
    context: {},
    _handled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal h3 event stub for unit-level handler invocation
  } as any;
}

beforeAll(() => {
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
  );
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'zh-CN.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n',
  );
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'MyClip.mp4', '.mp4', 0, Date.now(), Date.now());
  db.exec(`
    INSERT INTO transcribe_tasks (id, video_sha, status, model, total_chunks, done_chunks, created_at)
    VALUES ('task-export', '${HASH}', 'done', 'base', 1, 1, ${Date.now()});
    INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json, speaker_timeline)
    VALUES (
      'task-export',
      0,
      0,
      1000,
      '[]',
      '[{"startMs":0,"endMs":1000,"speakerId":"speaker_A"}]'
    );
    INSERT INTO diarize_tasks
      (id, video_sha, status, raw_speaker_count, final_speaker_count, unknown_duration_s, unknown_ratio, top_k, mode, created_at, completed_at)
    VALUES ('diarize-export', '${HASH}', 'done', 1, 1, 0, 0, 1, 'top_k', ${Date.now()}, ${Date.now()});
    INSERT INTO speakers (video_sha, speaker_id, display_name)
    VALUES ('${HASH}', 'speaker_A', 'Alice');
  `);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/api/export single-language', () => {
  it('returns VTT for original language', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'vtt' });
    const body = await handler(event);
    expect(typeof body).toBe('string');
    expect(body as string).toContain('WEBVTT');
    expect(body as string).toContain('Hello');
  });

  it('includes speaker labels when speakers=1', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'vtt', speakers: '1' });
    const body = await handler(event);
    expect(body as string).toContain('Alice: Hello');
  });

  it('returns SRT-formatted body for format=srt', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'srt' });
    const body = await handler(event);
    expect(body as string).toMatch(/^1\n00:00:00,000 --> 00:00:01,000\nHello/);
  });

  it('returns plain text for format=txt', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'txt' });
    expect((await handler(event)) as string).toBe('Hello\n');
  });

  it('400 on bad hash', async () => {
    const event = makeEvent({ hash: 'badhash', langs: 'original', format: 'vtt' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404 when video unknown', async () => {
    const event = makeEvent({ hash: 'b'.repeat(64), langs: 'original', format: 'vtt' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('400 when lang not cached', async () => {
    const event = makeEvent({ hash: HASH, langs: 'fr-FR', format: 'vtt' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 on invalid format', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'docx' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects langs containing path traversal', async () => {
    const event = makeEvent({ hash: HASH, langs: '../../../etc/passwd', format: 'vtt' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 on duplicate lang codes', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'zh-CN,zh-CN',
      format: 'srt',
    });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

});


describe('/api/export bilingual', () => {
  it('merges original + zh-CN into a single VTT', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,zh-CN',
      format: 'bilingual-vtt',
    });
    const body = (await handler(event)) as string;
    expect(body).toContain('WEBVTT');
    expect(body).toContain('Hello\n你好');
  });

  it('produces SRT for bilingual-srt format', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,zh-CN',
      format: 'bilingual-srt',
    });
    const body = (await handler(event)) as string;
    expect(body).toMatch(/^1\n00:00:00,000 --> 00:00:01,000\nHello\n你好/);
  });

  it('rejects bilingual with langs.length !== 2', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'bilingual-vtt' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 when requested lang not cached', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,fr-FR',
      format: 'bilingual-vtt',
    });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('/api/export multi-language ZIP', () => {
  it('returns a ZIP containing one SRT per requested lang', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,zh-CN',
      format: 'srt',
    });
    const body = await handler(event);
    expect(body).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(body as Buffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['MyClip.original.srt', 'MyClip.zh-CN.srt']);
    const en = await zip.files['MyClip.original.srt']!.async('string');
    expect(en).toContain('Hello');
    const zh = await zip.files['MyClip.zh-CN.srt']!.async('string');
    expect(zh).toContain('你好');
  });

  it('400 when any requested lang is not cached', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,fr-FR',
      format: 'srt',
    });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });
});
