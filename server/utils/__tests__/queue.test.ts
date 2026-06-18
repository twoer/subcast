/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// SUBCAST_HOME must be set before db.ts is loaded — its top-level const
// `SUBCAST_HOME` snapshots process.env at module-import time.
const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-queue-'));
  process.env.SUBCAST_HOME = r;
  return { tmpRoot: r };
});

/* eslint-disable import/first */
import { getDb } from '../db';
import { transcribeQueue, translateQueue } from '../queue';
/* eslint-enable import/first */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/**
 * Reset DB state between tests. Truncates the task tables we touch so
 * each case starts from a known empty slate; videos table needs a row
 * because the tasks tables have a FK constraint on it.
 */
function resetTaskTables(): void {
  const db = getDb();
  db.exec('DELETE FROM chunks');
  db.exec('DELETE FROM transcribe_tasks');
  db.exec('DELETE FROM translate_tasks');
  db.exec('DELETE FROM subtitles');
  db.exec('DELETE FROM videos');
  // Re-seed video rows so subsequent ensureTask calls have valid FKs.
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, '.mp4', 1024, ?, ?)`,
  );
  stmt.run(HASH_A, 'a.mp4', now, now);
  stmt.run(HASH_B, 'b.mp4', now, now);
}

beforeEach(() => {
  resetTaskTables();
});

describe('transcribeQueue.ensureTask', () => {
  it('creates a fresh queued row when no task exists for the video', () => {
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    expect(task.status).toBe('queued');
    expect(task.video_sha).toBe(HASH_A);
    expect(task.model).toBe('base');
    expect(task.done_chunks).toBe(0);
    expect(task.error_msg).toBe(null);
  });

  it('returns the existing row when one is already queued (idempotent)', () => {
    const first = transcribeQueue.ensureTask(HASH_A, 'base');
    const second = transcribeQueue.ensureTask(HASH_A, 'small');
    expect(second.id).toBe(first.id);
    // Model from the existing row wins — ensureTask never silently
    // rewrites it. Callers that want a model change use the retry endpoint.
    expect(second.model).toBe('base');
  });

  it('resurrects a failed task back to queued and clears error_msg', () => {
    const db = getDb();
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    db.prepare(
      `UPDATE transcribe_tasks SET status='failed', error_msg='boom' WHERE id=?`,
    ).run(task.id);

    const resurrected = transcribeQueue.ensureTask(HASH_A);
    expect(resurrected.id).toBe(task.id);
    expect(resurrected.status).toBe('queued');
    expect(resurrected.error_msg).toBe(null);

    // DB row should reflect the change too.
    const row = db
      .prepare(`SELECT status, error_msg FROM transcribe_tasks WHERE id=?`)
      .get(task.id) as { status: string; error_msg: string | null };
    expect(row.status).toBe('queued');
    expect(row.error_msg).toBe(null);
  });

  it('resurrects a canceled task back to queued', () => {
    const db = getDb();
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    db.prepare(`UPDATE transcribe_tasks SET status='canceled' WHERE id=?`).run(task.id);

    const resurrected = transcribeQueue.ensureTask(HASH_A);
    expect(resurrected.status).toBe('queued');
  });

  it('does NOT resurrect a completed task (it stays completed)', () => {
    const db = getDb();
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    db.prepare(
      `UPDATE transcribe_tasks SET status='completed', completed_at=? WHERE id=?`,
    ).run(Date.now(), task.id);

    const result = transcribeQueue.ensureTask(HASH_A);
    expect(result.status).toBe('completed');
  });

  it('preserves done_chunks across resurrection (chunk-level resume contract)', () => {
    const db = getDb();
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    db.prepare(
      `UPDATE transcribe_tasks SET status='failed', done_chunks=5, total_chunks=10 WHERE id=?`,
    ).run(task.id);

    const resurrected = transcribeQueue.ensureTask(HASH_A);
    expect(resurrected.status).toBe('queued');
    expect(resurrected.done_chunks).toBe(5);
    expect(resurrected.total_chunks).toBe(10);
  });
});

describe('transcribeQueue.cancel', () => {
  it('flips a queued task to canceled and returns true', () => {
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    expect(transcribeQueue.cancel(task.id)).toBe(true);
    const row = getDb()
      .prepare(`SELECT status FROM transcribe_tasks WHERE id=?`)
      .get(task.id) as { status: string };
    expect(row.status).toBe('canceled');
  });

  it('returns false for a terminal task (no double-cancel)', () => {
    const task = transcribeQueue.ensureTask(HASH_A, 'base');
    getDb()
      .prepare(`UPDATE transcribe_tasks SET status='completed' WHERE id=?`)
      .run(task.id);
    expect(transcribeQueue.cancel(task.id)).toBe(false);
  });

  it('returns false for an unknown task id', () => {
    expect(transcribeQueue.cancel('does-not-exist')).toBe(false);
  });

  it('cancelAll flips queued and running tasks to canceled', async () => {
    const queued = transcribeQueue.ensureTask(HASH_A, 'base');
    const running = transcribeQueue.ensureTask(HASH_B, 'base');
    getDb()
      .prepare(`UPDATE transcribe_tasks SET status='running' WHERE id=?`)
      .run(running.id);

    await transcribeQueue.cancelAll('test');

    const rows = getDb()
      .prepare(`SELECT id, status FROM transcribe_tasks ORDER BY id`)
      .all() as Array<{ id: string; status: string }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: queued.id, status: 'canceled' }),
        expect.objectContaining({ id: running.id, status: 'canceled' }),
      ]),
    );
  });
});

describe('translateQueue.ensureTask + bumpPriority', () => {
  it('resurrects a failed translation and resets progress to 0', () => {
    const db = getDb();
    const t = translateQueue.ensureTask(HASH_A, 'zh-CN');
    db.prepare(
      `UPDATE translate_tasks SET status='failed', error_msg='llm crashed', progress_pct=42 WHERE id=?`,
    ).run(t.id);

    const r = translateQueue.ensureTask(HASH_A, 'zh-CN');
    expect(r.status).toBe('queued');
    expect(r.error_msg).toBe(null);
    expect(r.progress_pct).toBe(0);
  });

  it('treats (videoSha, lang) as the uniqueness key — same hash + different lang = different row', () => {
    const a = translateQueue.ensureTask(HASH_A, 'zh-CN');
    const b = translateQueue.ensureTask(HASH_A, 'ja-JP');
    expect(a.id).not.toBe(b.id);
  });

  it('bumpPriority raises priority above existing rows', () => {
    const db = getDb();
    const a = translateQueue.ensureTask(HASH_A, 'zh-CN');
    const b = translateQueue.ensureTask(HASH_B, 'ja-JP');

    // Initially both rows have priority 0.
    let rows = db
      .prepare(`SELECT id, priority FROM translate_tasks ORDER BY id`)
      .all() as Array<{ id: string; priority: number }>;
    expect(rows.every((r) => r.priority === 0)).toBe(true);

    translateQueue.bumpPriority(b.id);
    rows = db
      .prepare(`SELECT id, priority FROM translate_tasks ORDER BY priority DESC`)
      .all() as Array<{ id: string; priority: number }>;
    // After bump, b has higher priority than a; the head of the priority
    // queue is the bumped row.
    expect(rows[0]?.id).toBe(b.id);
    expect(rows[0]?.priority).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === a.id)?.priority).toBe(0);
  });
});

describe('cross-queue independence', () => {
  it('transcribe and translate tasks for the same video are independent', () => {
    const tr = transcribeQueue.ensureTask(HASH_A, 'base');
    const tl = translateQueue.ensureTask(HASH_A, 'zh-CN');
    expect(tr.id).not.toBe(tl.id);

    // Canceling one doesn't affect the other.
    transcribeQueue.cancel(tr.id);
    const tlRow = getDb()
      .prepare(`SELECT status FROM translate_tasks WHERE id=?`)
      .get(tl.id) as { status: string };
    expect(tlRow.status).toBe('queued');
  });
});

// Hint to TS that tmpRoot is used — keeps the import in scope.
expect(tmpRoot).toBeDefined();
