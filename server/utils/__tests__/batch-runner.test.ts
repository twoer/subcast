/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-batch-runner-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import type { BatchOptions } from '../../types/batch';
import { createBatchJob, getBatchJob } from '../batchRepo';
import { runBatchOnce, type BatchRunnerAdapter } from '../batchRunner';
import { getDb } from '../db';
/* eslint-enable import/first */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function options(overrides: Partial<BatchOptions> = {}): BatchOptions {
  return {
    whisperModel: 'base',
    targetLangs: ['zh-CN'],
    insights: true,
    diarize: true,
    ...overrides,
  };
}

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

function fakeAdapter(calls: string[], fail?: string): BatchRunnerAdapter {
  const run = async (label: string) => {
    calls.push(label);
    if (label === fail) throw new Error(`failed ${label}`);
  };
  return {
    hasTranscript: () => false,
    hasTranslation: () => false,
    hasInsights: () => false,
    hasDiarization: () => false,
    runTranscribe: (hash) => run(`${hash[0]}:transcribe`),
    runTranslate: (hash, lang) => run(`${hash[0]}:translate:${lang}`),
    runInsights: (hash) => run(`${hash[0]}:insights`),
    runDiarize: (hash) => run(`${hash[0]}:diarize`),
  };
}

beforeEach(resetDb);

describe('runBatchOnce', () => {
  it('runs the full selected workflow for one file before starting the next', async () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'full',
      options: options(),
      videoShas: [HASH_A, HASH_B],
    });
    const calls: string[] = [];

    await runBatchOnce(id, { adapter: fakeAdapter(calls) });

    expect(calls).toEqual([
      'a:transcribe',
      'a:translate:zh-CN',
      'a:insights',
      'a:diarize',
      'b:transcribe',
      'b:translate:zh-CN',
      'b:insights',
      'b:diarize',
    ]);
    expect(getBatchJob(id)).toMatchObject({
      status: 'completed',
      doneItems: 2,
      failedItems: 0,
    });
  });

  it('skips artifacts that already exist', async () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'translate',
      options: options({ insights: false, diarize: false }),
      videoShas: [HASH_A],
    });
    const calls: string[] = [];
    const adapter = fakeAdapter(calls);
    adapter.hasTranscript = () => true;
    adapter.hasTranslation = () => true;

    await runBatchOnce(id, { adapter });

    expect(calls).toEqual([]);
    const item = getBatchJob(id)!.items[0]!;
    expect(item.stepStatus.transcribe).toBe('skipped');
    expect(item.stepStatus.translate?.['zh-CN']).toBe('skipped');
  });

  it('marks one failed item and continues with the next file', async () => {
    const { id } = createBatchJob({
      name: 'Batch',
      preset: 'full',
      options: options(),
      videoShas: [HASH_A, HASH_B],
    });
    const calls: string[] = [];

    await runBatchOnce(id, { adapter: fakeAdapter(calls, 'a:translate:zh-CN') });

    expect(calls).toEqual([
      'a:transcribe',
      'a:translate:zh-CN',
      'b:transcribe',
      'b:translate:zh-CN',
      'b:insights',
      'b:diarize',
    ]);
    const job = getBatchJob(id)!;
    expect(job).toMatchObject({ status: 'failed', doneItems: 1, failedItems: 1 });
    expect(job.items[0]).toMatchObject({ status: 'failed', errorMsg: 'failed a:translate:zh-CN' });
    expect(job.items[1]).toMatchObject({ status: 'completed' });
  });
});
