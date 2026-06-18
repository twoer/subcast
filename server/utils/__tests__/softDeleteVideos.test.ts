/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// SUBCAST_HOME must be set before db.ts is loaded.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-softdel-'));
});

/* eslint-disable import/first */
import { getDb } from '../db';
/* eslint-enable import/first */

const HASH = 'c'.repeat(64);

function seedVideo(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'test.mp4', '.mp4', 1024, ?, ?)`,
  ).run(HASH, now, now);
}

function seedTask(): string {
  const db = getDb();
  const id = 'task-' + HASH.slice(0, 8);
  db.prepare(
    `INSERT OR REPLACE INTO transcribe_tasks
     (id, video_sha, status, model, created_at)
     VALUES (?, ?, 'completed', 'small', ?)`,
  ).run(id, HASH, Date.now());
  return id;
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM transcribe_tasks');
  db.exec('DELETE FROM videos');
});

describe('soft-delete videos', () => {
  it('sets deleted_at and preserves the video row', () => {
    seedVideo();
    const db = getDb();
    db.prepare(
      `UPDATE videos SET deleted_at = ? WHERE sha256 = ? AND deleted_at IS NULL`,
    ).run(Date.now(), HASH);

    const row = db.prepare(`SELECT deleted_at FROM videos WHERE sha256 = ?`).get(HASH) as {
      deleted_at: number | null;
    };
    expect(row).not.toBeNull();
    expect(row!.deleted_at).toBeGreaterThan(0);
  });

  it('preserves task row after soft-delete', () => {
    seedVideo();
    const taskId = seedTask();
    const db = getDb();

    db.prepare(
      `UPDATE videos SET deleted_at = ? WHERE sha256 = ? AND deleted_at IS NULL`,
    ).run(Date.now(), HASH);

    const task = db.prepare(`SELECT id FROM transcribe_tasks WHERE id = ?`).get(taskId);
    expect(task).not.toBeNull();
  });

  it('re-upload un-deletes the row', () => {
    seedVideo();
    const db = getDb();
    db.prepare(`UPDATE videos SET deleted_at = ? WHERE sha256 = ?`).run(Date.now(), HASH);

    const now = Date.now();
    db.prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES (?, 'test.mp4', '.mp4', 1024, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET last_opened_at = excluded.last_opened_at, deleted_at = NULL`,
    ).run(HASH, now, now);

    const row = db.prepare(`SELECT deleted_at FROM videos WHERE sha256 = ?`).get(HASH) as {
      deleted_at: number | null;
    };
    expect(row!.deleted_at).toBeNull();
  });

  it('hides soft-deleted rows from cache list query', () => {
    seedVideo();
    const db = getDb();
    db.prepare(`UPDATE videos SET deleted_at = ? WHERE sha256 = ?`).run(Date.now(), HASH);

    const rows = db
      .prepare(`SELECT sha256 FROM videos WHERE deleted_at IS NULL`)
      .all() as { sha256: string }[];
    expect(rows.find((r) => r.sha256 === HASH)).toBeUndefined();
  });
});
