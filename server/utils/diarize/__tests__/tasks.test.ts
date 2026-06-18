/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-diarize-tasks-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { getDb } from '../../db';
import { ensureDiarizeTask } from '../tasks';
/* eslint-enable import/first */

const HASH = 'd'.repeat(64);

function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM chunks;
    DELETE FROM diarize_tasks;
    DELETE FROM transcribe_tasks;
    DELETE FROM videos;
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'clip.mp4', '.mp4', 1024, ?, ?)`,
  ).run(HASH, now, now);
}

function seedCompletedTranscribe(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO transcribe_tasks
      (id, video_sha, status, model, total_chunks, done_chunks, created_at, completed_at)
     VALUES ('tx', ?, 'completed', 'base', 1, 1, ?, ?)`,
  ).run(HASH, now, now);
  db.prepare(
    `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json)
     VALUES ('tx', 0, 0, 1000, ?)`,
  ).run(JSON.stringify([{ startMs: 0, endMs: 1000, text: 'hello' }]));
}

beforeEach(resetDb);

describe('ensureDiarizeTask', () => {
  it('rejects videos without completed transcribe chunks', () => {
    expect(() => ensureDiarizeTask(HASH)).toThrow('TRANSCRIBE_NOT_DONE');
  });

  it('creates a running diarize task for a ready video', () => {
    seedCompletedTranscribe();

    const task = ensureDiarizeTask(HASH, { topK: 3 });

    expect(task).toMatchObject({ status: 'running', alreadyRunning: false });
    const row = getDb()
      .prepare(`SELECT status, top_k FROM diarize_tasks WHERE id = ?`)
      .get(task.taskId) as { status: string; top_k: number | null };
    expect(row).toEqual({ status: 'running', top_k: 3 });
  });

  it('returns an existing running task without creating a duplicate', () => {
    seedCompletedTranscribe();
    const first = ensureDiarizeTask(HASH);
    const second = ensureDiarizeTask(HASH);

    expect(second).toEqual({
      taskId: first.taskId,
      status: 'running',
      alreadyRunning: true,
    });
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM diarize_tasks WHERE video_sha = ?`)
      .get(HASH) as { n: number };
    expect(count.n).toBe(1);
  });

  it('reuses a failed row by setting it back to running', () => {
    seedCompletedTranscribe();
    const first = ensureDiarizeTask(HASH);
    getDb()
      .prepare(`UPDATE diarize_tasks SET status='failed', error_msg='boom', completed_at=? WHERE id=?`)
      .run(Date.now(), first.taskId);

    const retried = ensureDiarizeTask(HASH, { topK: 4 });

    expect(retried).toEqual({
      taskId: first.taskId,
      status: 'running',
      alreadyRunning: false,
    });
    const row = getDb()
      .prepare(`SELECT status, error_msg, completed_at, top_k FROM diarize_tasks WHERE id=?`)
      .get(first.taskId) as {
        status: string;
        error_msg: string | null;
        completed_at: number | null;
        top_k: number | null;
      };
    expect(row).toEqual({
      status: 'running',
      error_msg: null,
      completed_at: null,
      top_k: 4,
    });
  });
});
