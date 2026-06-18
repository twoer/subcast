/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-diarize-readiness-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { getDb } from '../../db';
import { hasCompletedTranscribeChunks } from '../readiness';
/* eslint-enable import/first */

const HASH = 'e'.repeat(64);

function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM chunks;
    DELETE FROM transcribe_tasks;
    DELETE FROM videos;
  `);
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'clip.mp4', '.mp4', 1024, ?, ?)`,
  ).run(HASH, now, now);
}

function insertTask(status: string, withChunk: boolean): void {
  const now = Date.now();
  db().prepare(
    `INSERT INTO transcribe_tasks
       (id, video_sha, status, model, total_chunks, done_chunks, created_at, completed_at)
     VALUES (?, ?, ?, 'base', 1, ?, ?, ?)`,
  ).run(`task-${status}-${withChunk ? 'chunk' : 'empty'}`, HASH, status, withChunk ? 1 : 0, now, status === 'completed' ? now : null);
  if (!withChunk) return;
  db().prepare(
    `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json)
     VALUES (?, 0, 0, 1000, ?)`,
  ).run(`task-${status}-chunk`, JSON.stringify([{ startMs: 0, endMs: 1000, text: 'hello' }]));
}

function db() {
  return getDb();
}

beforeEach(resetDb);

describe('hasCompletedTranscribeChunks', () => {
  it('rejects partial chunks from a still-running transcribe task', () => {
    insertTask('running', true);

    expect(hasCompletedTranscribeChunks(db(), HASH)).toBe(false);
  });

  it('rejects a completed transcribe task without chunk rows', () => {
    insertTask('completed', false);

    expect(hasCompletedTranscribeChunks(db(), HASH)).toBe(false);
  });

  it('allows diarize only after a completed transcribe task has chunks', () => {
    insertTask('completed', true);

    expect(hasCompletedTranscribeChunks(db(), HASH)).toBe(true);
  });
});
