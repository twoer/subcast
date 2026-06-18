/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-batch-api-'));
});

vi.mock('../batchRunner', () => ({
  startBatch: vi.fn(async () => {}),
  cancelBatchChildren: vi.fn(() => {}),
}));

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>();
  return {
    ...actual,
    readBody: async (event: { _body?: unknown }) => event._body,
  };
});

/* eslint-disable import/first -- hoisted env/mocks must precede imports */
import { getDb, SUBCAST_PATHS } from '../db';
import { createBatchJob, getBatchJob, markItemStatus } from '../batchRepo';
import { cancelBatchChildren, startBatch } from '../batchRunner';
import createHandler from '../../api/batches/index.post';
import listHandler from '../../api/batches/index.get';
import detailHandler from '../../api/batches/[id].get';
import cancelHandler from '../../api/batches/[id]/cancel.post';
import retryHandler from '../../api/batches/[id]/retry.post';
import previewHandler from '../../api/batches/preview.post';
/* eslint-enable import/first */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function eventWithBody(body: unknown) {
  return {
    node: { req: { method: 'POST', headers: {} }, res: {} },
    context: {},
    _body: body,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function eventWithParam(id: string) {
  return {
    node: { req: { method: 'GET', headers: {} }, res: {} },
    context: { params: { id } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM batch_items;
    DELETE FROM batch_jobs;
    DELETE FROM videos;
  `);
  rmSync(SUBCAST_PATHS.cache, { recursive: true, force: true });
  mkdirSync(SUBCAST_PATHS.cache, { recursive: true });
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, '.mp4', 1024, ?, ?)`,
  );
  insert.run(HASH_A, 'a.mp4', now, now);
  insert.run(HASH_B, 'b.mp4', now, now);
  vi.mocked(startBatch).mockClear();
  vi.mocked(cancelBatchChildren).mockClear();
}

beforeEach(resetDb);

describe('/api/batches', () => {
  it('creates a batch and starts the runner', async () => {
    const res = await createHandler(eventWithBody({
      name: 'Batch',
      preset: 'full',
      videoShas: [HASH_A, HASH_B],
      options: {
        whisperModel: 'base',
        targetLangs: ['zh-CN'],
        insights: true,
        insightLanguage: 'en',
        diarize: true,
      },
    }));

    expect(res.id).toEqual(expect.any(String));
    expect(getBatchJob(res.id)?.items).toHaveLength(2);
    expect(startBatch).toHaveBeenCalledWith(res.id);
  });

  it('does not create a batch when all selected outputs already exist', async () => {
    const cacheDir = join(SUBCAST_PATHS.cache, HASH_A);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'original.vtt'), 'WEBVTT\n');

    const res = await createHandler(eventWithBody({
      name: 'Batch',
      preset: 'transcribe',
      videoShas: [HASH_A],
      options: {
        whisperModel: 'base',
        targetLangs: [],
        insights: false,
        diarize: false,
      },
    }));

    expect(res).toEqual({
      id: null,
      skipped: true,
      totalVideos: 1,
      readyVideos: 1,
    });
    expect(startBatch).not.toHaveBeenCalled();
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM batch_jobs').get()).toMatchObject({ n: 0 });
  });

  it('creates a batch only for files with missing selected outputs', async () => {
    const cacheDir = join(SUBCAST_PATHS.cache, HASH_A);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'original.vtt'), 'WEBVTT\n');

    const res = await createHandler(eventWithBody({
      name: 'Batch',
      preset: 'transcribe',
      videoShas: [HASH_A, HASH_B],
      options: {
        whisperModel: 'base',
        targetLangs: [],
        insights: false,
        diarize: false,
      },
    }));

    expect(res).toMatchObject({
      skipped: false,
      totalVideos: 2,
      readyVideos: 1,
      queuedVideos: 1,
    });
    expect(getBatchJob(res.id!)?.items).toEqual([
      expect.objectContaining({ videoSha: HASH_B }),
    ]);
    expect(startBatch).toHaveBeenCalledWith(res.id);
  });

  it('previews mixed existing-ready and staged-new files', async () => {
    const cacheDir = join(SUBCAST_PATHS.cache, HASH_A);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'original.vtt'), 'WEBVTT\n');
    getDb().prepare('DELETE FROM videos WHERE sha256 = ?').run(HASH_B);

    const res = await previewHandler(eventWithBody({
      videoShas: [HASH_A, HASH_B],
      options: {
        whisperModel: 'base',
        targetLangs: [],
        insights: false,
        diarize: false,
      },
    }));

    expect(res).toEqual({
      totalVideos: 2,
      readyVideos: 1,
      queuedVideos: 1,
      allReady: false,
    });
  });

  it('previews staged-new files as queued work', async () => {
    getDb().prepare('DELETE FROM videos WHERE sha256 = ?').run(HASH_B);

    const res = await previewHandler(eventWithBody({
      videoShas: [HASH_B],
      options: {
        whisperModel: 'base',
        targetLangs: [],
        insights: false,
        diarize: false,
      },
    }));

    expect(res).toEqual({
      totalVideos: 1,
      readyVideos: 0,
      queuedVideos: 1,
      allReady: false,
    });
  });

  it('rejects invalid target languages', async () => {
    await expect(createHandler(eventWithBody({
      name: 'Bad',
      preset: 'full',
      videoShas: [HASH_A],
      options: {
        whisperModel: 'base',
        targetLangs: ['../../bad'],
        insights: false,
        diarize: false,
      },
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lists and returns batch details', async () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'transcribe',
      videoShas: [HASH_A],
      options: { whisperModel: 'base', targetLangs: [], insights: false, diarize: false },
    });

    expect(listHandler(eventWithBody({}))).toMatchObject({
      items: [expect.objectContaining({ id })],
    });
    expect(detailHandler(eventWithParam(id))).toMatchObject({
      job: expect.objectContaining({ id, items: [expect.objectContaining({ videoSha: HASH_A })] }),
    });
  });

  it('cancels a batch', async () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'transcribe',
      videoShas: [HASH_A],
      options: { whisperModel: 'base', targetLangs: [], insights: false, diarize: false },
    });

    expect(cancelHandler(eventWithParam(id))).toEqual({ ok: true });
    expect(cancelBatchChildren).toHaveBeenCalledWith(id);
    expect(getBatchJob(id)?.status).toBe('canceled');
  });

  it('retries failed items and starts the runner', async () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'transcribe',
      videoShas: [HASH_A],
      options: { whisperModel: 'base', targetLangs: [], insights: false, diarize: false },
    });
    const item = getBatchJob(id)!.items[0]!;
    markItemStatus(item.id, 'failed', 'boom');

    expect(retryHandler(eventWithParam(id))).toEqual({ ok: true });

    expect(getBatchJob(id)?.items[0]?.status).toBe('queued');
    expect(startBatch).toHaveBeenCalledWith(id);
  });
});
