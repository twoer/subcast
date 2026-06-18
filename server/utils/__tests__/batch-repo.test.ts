/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-batch-repo-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import type { BatchOptions } from '../../types/batch';
import { getDb } from '../db';
import {
  cancelBatch,
  createBatchJob,
  getBatchJob,
  listBatchJobs,
  markItemStatus,
  markItemStep,
  recomputeBatchStatus,
} from '../batchRepo';
/* eslint-enable import/first */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const OPTIONS: BatchOptions = {
  whisperModel: 'base',
  targetLangs: ['zh-CN'],
  insights: true,
  diarize: false,
};

function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM batch_items;
    DELETE FROM batch_jobs;
    DELETE FROM videos;
  `);
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, '.mp4', 1024, ?, ?)`,
  );
  insert.run(HASH_A, 'a.mp4', now, now);
  insert.run(HASH_B, 'b.mp4', now, now);
}

beforeEach(resetDb);

describe('batchRepo', () => {
  it('creates a batch job with one item per video', () => {
    const { id } = createBatchJob({
      name: 'Morning batch',
      preset: 'transcribe_translate_insights',
      options: OPTIONS,
      videoShas: [HASH_A, HASH_B],
    });

    const detail = getBatchJob(id);
    expect(detail).toMatchObject({
      id,
      name: 'Morning batch',
      status: 'queued',
      totalItems: 2,
      doneItems: 0,
      failedItems: 0,
      options: OPTIONS,
    });
    expect(detail?.items.map((i) => i.videoSha).sort()).toEqual([HASH_A, HASH_B]);
    expect(detail?.items.every((i) => i.status === 'queued')).toBe(true);
  });

  it('updates item steps and recomputes aggregate job counts', () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'all',
      options: OPTIONS,
      videoShas: [HASH_A, HASH_B],
    });
    const detail = getBatchJob(id);
    const [first, second] = detail!.items;

    markItemStep(first!.id, 'translate', 'running', 'zh-CN');
    expect(getBatchJob(id)?.items[0]?.stepStatus.translate?.['zh-CN']).toBe('running');

    markItemStatus(first!.id, 'completed');
    markItemStatus(second!.id, 'failed', 'boom');
    recomputeBatchStatus(id);

    expect(getBatchJob(id)).toMatchObject({
      status: 'failed',
      doneItems: 1,
      failedItems: 1,
    });
  });

  it('marks a batch completed when every item completes', () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'all',
      options: OPTIONS,
      videoShas: [HASH_A, HASH_B],
    });
    const detail = getBatchJob(id)!;
    for (const item of detail.items) markItemStatus(item.id, 'completed');
    recomputeBatchStatus(id);

    expect(getBatchJob(id)?.status).toBe('completed');
  });

  it('cancels queued and running batch items', () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'all',
      options: OPTIONS,
      videoShas: [HASH_A, HASH_B],
    });
    const detail = getBatchJob(id)!;
    markItemStatus(detail.items[0]!.id, 'running');

    cancelBatch(id);

    const canceled = getBatchJob(id)!;
    expect(canceled.status).toBe('canceled');
    expect(canceled.items.map((i) => i.status)).toEqual(['canceled', 'canceled']);
  });

  it('lists newest batch jobs first', () => {
    const first = createBatchJob({
      name: 'First',
      preset: 'all',
      options: OPTIONS,
      videoShas: [HASH_A],
    });
    const second = createBatchJob({
      name: 'Second',
      preset: 'all',
      options: OPTIONS,
      videoShas: [HASH_B],
    });

    expect(listBatchJobs().map((j) => j.id)).toEqual([second.id, first.id]);
  });
});
