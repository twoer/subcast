/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-media-graph-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { getDb } from '../db';
import { clearMediaGraph, deleteVideoGraph } from '../mediaGraphDelete';
/* eslint-enable import/first */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function seedLegacyDiarizationTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS diarize_tasks (
      id                   TEXT PRIMARY KEY,
      video_sha            TEXT NOT NULL REFERENCES videos(sha256),
      status               TEXT NOT NULL,
      created_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS diarize_raw_speakers (
      video_sha       TEXT NOT NULL REFERENCES videos(sha256),
      raw_speaker     INTEGER NOT NULL,
      duration_s      REAL NOT NULL,
      segment_count   INTEGER NOT NULL,
      centroid_emb    BLOB NOT NULL,
      PRIMARY KEY (video_sha, raw_speaker)
    );
    CREATE TABLE IF NOT EXISTS speakers (
      video_sha     TEXT NOT NULL REFERENCES videos(sha256),
      speaker_id    TEXT NOT NULL,
      display_name  TEXT,
      PRIMARY KEY (video_sha, speaker_id)
    );
  `);
}

function seedVideoGraph(hash: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'clip.mp4', '.mp4', 1024, ?, ?)`,
  ).run(hash, now, now);
  db.prepare(
    `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
     VALUES (?, ?, 'completed', 'base', ?)`,
  ).run(`tx-${hash[0]}`, hash, now);
  db.prepare(
    `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json)
     VALUES (?, 0, 0, 1000, '[]')`,
  ).run(`tx-${hash[0]}`);
  db.prepare(
    `INSERT INTO translate_tasks (id, video_sha, target_lang, status, model, created_at)
     VALUES (?, ?, 'zh-CN', 'completed', 'qwen', ?)`,
  ).run(`tr-${hash[0]}`, hash, now);
  db.prepare(
    `INSERT INTO insight_tasks (id, video_sha, status, model, ui_language, created_at)
     VALUES (?, ?, 'done', 'qwen', 'zh-CN', ?)`,
  ).run(`in-${hash[0]}`, hash, now);
  db.prepare(
    `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
     VALUES (?, 'original', 'vtt', 1, ?)`,
  ).run(hash, now);
  db.prepare(
    `INSERT INTO diarize_tasks (id, video_sha, status, created_at)
     VALUES (?, ?, 'done', ?)`,
  ).run(`dia-${hash[0]}`, hash, now);
  db.prepare(
    `INSERT INTO diarize_raw_speakers
     (video_sha, raw_speaker, duration_s, segment_count, centroid_emb)
     VALUES (?, 0, 1.2, 3, ?)`,
  ).run(hash, Buffer.from([1, 2, 3]));
  db.prepare(
    `INSERT INTO speakers (video_sha, speaker_id, display_name)
     VALUES (?, 'SPEAKER_00', 'Speaker 1')`,
  ).run(hash);
}

function seedBatchGraph(): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO batch_jobs
      (id, name, status, preset, options_json, total_items, created_at)
     VALUES ('batch-1', 'Batch', 'completed', 'all', '{}', 2, ?)`,
  ).run(now);
  const insertItem = db.prepare(
    `INSERT INTO batch_items
      (id, batch_id, video_sha, status, step_status_json, created_at)
     VALUES (?, 'batch-1', ?, 'completed', '{}', ?)`,
  );
  insertItem.run('batch-a', HASH_A, now);
  insertItem.run('batch-b', HASH_B, now);
}

function count(table: string, where = '', params: unknown[] = []): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
}

function expectNoForeignKeyViolations(): void {
  expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

beforeEach(() => {
  const db = getDb();
  seedLegacyDiarizationTables();
  db.exec(`
    DELETE FROM chunks;
    DELETE FROM subtitles;
    DELETE FROM transcribe_tasks;
    DELETE FROM translate_tasks;
    DELETE FROM insight_tasks;
    DELETE FROM batch_items;
    DELETE FROM batch_jobs;
    DELETE FROM diarize_raw_speakers;
    DELETE FROM speakers;
    DELETE FROM diarize_tasks;
    DELETE FROM videos;
  `);
});

describe('media graph delete helpers', () => {
  it('deletes only one video graph including legacy diarization rows', () => {
    seedVideoGraph(HASH_A);
    seedVideoGraph(HASH_B);
    seedBatchGraph();
    expectNoForeignKeyViolations();

    deleteVideoGraph(getDb(), HASH_A);

    expect(count('videos', 'WHERE sha256 = ?', [HASH_A])).toBe(0);
    expect(count('videos', 'WHERE sha256 = ?', [HASH_B])).toBe(1);
    for (const table of [
      'subtitles',
      'transcribe_tasks',
      'translate_tasks',
      'insight_tasks',
      'diarize_tasks',
      'diarize_raw_speakers',
      'speakers',
    ]) {
      expect(count(table, 'WHERE video_sha = ?', [HASH_A])).toBe(0);
      expect(count(table, 'WHERE video_sha = ?', [HASH_B])).toBe(1);
    }
    expect(count('batch_items', 'WHERE video_sha = ?', [HASH_A])).toBe(0);
    expect(count('batch_items', 'WHERE video_sha = ?', [HASH_B])).toBe(1);
    expect(count('batch_jobs')).toBe(1);
    expect(count('chunks')).toBe(1);
    expectNoForeignKeyViolations();
  });

  it('can keep the video row while deleting derived rows for retry', () => {
    seedVideoGraph(HASH_A);

    deleteVideoGraph(getDb(), HASH_A, { keepVideo: true });

    expect(count('videos', 'WHERE sha256 = ?', [HASH_A])).toBe(1);
    for (const table of [
      'subtitles',
      'transcribe_tasks',
      'translate_tasks',
      'insight_tasks',
      'diarize_tasks',
      'diarize_raw_speakers',
      'speakers',
    ]) {
      expect(count(table)).toBe(0);
    }
    expect(count('chunks')).toBe(0);
    expectNoForeignKeyViolations();
  });

  it('clears every media graph while preserving an empty schema', () => {
    seedVideoGraph(HASH_A);
    seedVideoGraph(HASH_B);
    seedBatchGraph();

    clearMediaGraph(getDb());

    for (const table of [
      'videos',
      'chunks',
      'subtitles',
      'transcribe_tasks',
      'translate_tasks',
      'insight_tasks',
      'batch_items',
      'batch_jobs',
      'diarize_tasks',
      'diarize_raw_speakers',
      'speakers',
    ]) {
      expect(count(table)).toBe(0);
    }
    expectNoForeignKeyViolations();
  });
});
