/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-cache-clear-'));
  // Nuxt auto-imports defineEventHandler at build time; direct vitest imports
  // need the minimal runtime shim.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.defineEventHandler = (handler: any) => handler;
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import handler from '../../api/cache/clear.delete';
import { getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const HASH = 'd'.repeat(64);

function seedVideoGraph(): void {
  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'clip.mp4', '.mp4', 1024, ?, ?)`,
  ).run(HASH, now, now);
  db.prepare(
    `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
     VALUES ('tx-1', ?, 'completed', 'base', ?)`,
  ).run(HASH, now);
  db.prepare(
    `INSERT INTO translate_tasks (id, video_sha, target_lang, status, model, created_at)
     VALUES ('tr-1', ?, 'zh-CN', 'completed', 'qwen', ?)`,
  ).run(HASH, now);
  db.prepare(
    `INSERT INTO insight_tasks (id, video_sha, status, model, ui_language, created_at)
     VALUES ('in-1', ?, 'done', 'qwen', 'zh-CN', ?)`,
  ).run(HASH, now);
  db.prepare(
    `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
     VALUES (?, 'original', 'vtt', 1, ?)`,
  ).run(HASH, now);
  db.prepare(
    `INSERT INTO batch_jobs
      (id, name, status, preset, options_json, total_items, created_at)
     VALUES ('batch-1', 'Batch', 'completed', 'all', '{}', 1, ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO batch_items
      (id, batch_id, video_sha, status, step_status_json, created_at)
     VALUES ('batch-item-1', 'batch-1', ?, 'completed', '{}', ?)`,
  ).run(HASH, now);
}

function seedLegacyDiarizationTables(): void {
  const db = getDb();
  db.exec(`
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
  db.prepare(
    `INSERT INTO diarize_tasks (id, video_sha, status, created_at)
     VALUES ('dia-1', ?, 'done', ?)`,
  ).run(HASH, Date.now());
  db.prepare(
    `INSERT INTO diarize_raw_speakers
     (video_sha, raw_speaker, duration_s, segment_count, centroid_emb)
     VALUES (?, 0, 1.2, 3, ?)`,
  ).run(HASH, Buffer.from([1, 2, 3]));
  db.prepare(
    `INSERT INTO speakers (video_sha, speaker_id, display_name)
     VALUES (?, 'SPEAKER_00', 'Speaker 1')`,
  ).run(HASH);
}

function expectNoForeignKeyViolations(): void {
  const rows = getDb().prepare('PRAGMA foreign_key_check').all();
  expect(rows).toEqual([]);
}

describe('DELETE /api/cache/clear', () => {
  it('clears videos even when legacy diarization FK tables exist', async () => {
    seedVideoGraph();
    seedLegacyDiarizationTables();
    expectNoForeignKeyViolations();
    mkdirSync(SUBCAST_PATHS.videos, { recursive: true });
    mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
    writeFileSync(join(SUBCAST_PATHS.videos, `${HASH}.mp4`), 'video');
    writeFileSync(join(SUBCAST_PATHS.cache, HASH, 'original.vtt'), 'WEBVTT\n');

    await expect(handler({} as never)).resolves.toEqual({ ok: true });

    const db = getDb();
    for (const table of [
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
      'videos',
    ]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
    expectNoForeignKeyViolations();
  });

  it('does not remove Electron runtime cache directories sharing the cache root', async () => {
    seedVideoGraph();
    mkdirSync(SUBCAST_PATHS.videos, { recursive: true });
    mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
    mkdirSync(join(SUBCAST_PATHS.cache, 'Cache_Data'), { recursive: true });
    writeFileSync(join(SUBCAST_PATHS.videos, `${HASH}.mp4`), 'video');
    writeFileSync(join(SUBCAST_PATHS.cache, HASH, 'original.vtt'), 'WEBVTT\n');
    writeFileSync(join(SUBCAST_PATHS.cache, 'Cache_Data', 'index'), 'chromium cache');

    await expect(handler({} as never)).resolves.toEqual({ ok: true });

    expect(existsSync(join(SUBCAST_PATHS.cache, HASH))).toBe(false);
    expect(existsSync(join(SUBCAST_PATHS.cache, 'Cache_Data', 'index'))).toBe(true);
    expectNoForeignKeyViolations();
  });
});
