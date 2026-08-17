/* SPDX-License-Identifier: Apache-2.0 */
// Regression tests for the migration chain's self-healing guarantees.
//
// These encode the two failure modes observed with release 0.5.0 on
// machines that had previously run prototype builds (AI dubbing /
// knowledge-QA branches) against the same SUBCAST_HOME:
//
//  1. a foreign build stamped user_version = 14 with a different schema,
//     so release 0.5.0 skipped its step 14 and polish_tasks never got
//     created — every /api/queue/list poll 500'd with
//     "no such table: polish_tasks";
//  2. when migrate() throws mid-chain, getDb() used to cache the
//     half-migrated handle, hiding the real error and serving a broken
//     schema to every later request until app restart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { closeDb, getDb } from '../db';

// The videos shape as of user_version 13 (0.4.8) — enough for the
// polish_tasks FK and the queue/list join. Prototype-era extras omitted.
const VIDEOS_V13 = `
  CREATE TABLE videos (
    sha256          TEXT PRIMARY KEY,
    original_name   TEXT NOT NULL,
    ext             TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    duration_s      REAL,
    created_at      INTEGER NOT NULL,
    last_opened_at  INTEGER NOT NULL,
    display_name    TEXT,
    deleted_at      INTEGER DEFAULT NULL,
    has_waveform    INTEGER NOT NULL DEFAULT 0,
    has_diarization INTEGER NOT NULL DEFAULT 0,
    source_url      TEXT
  );
`;

/** Create a raw data.sqlite at `dir` and hand back nothing (closed). */
function seedRawDb(dir: string, fn: (db: Database.Database) => void): void {
  const db = new Database(join(dir, 'data.sqlite'));
  db.pragma('journal_mode = WAL');
  fn(db);
  db.close();
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name);
}

beforeEach(() => {
  closeDb();
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-db-mig-'));
});

afterEach(() => {
  closeDb();
});

describe('migrate() self-healing', () => {
  it('fresh database reaches user_version 16 with polish_tasks and invocation columns', () => {
    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(16);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'polish_tasks'`).all(),
    ).toHaveLength(1);
    // plan_kind defaults to 'segment' so pre-15 rows resume with their
    // original chunk geometry (see transcribeQueue replan).
    const hash15 = 'c'.repeat(64);
    db.prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES (?, 'v.mp4', '.mp4', 1, 0, 0)`,
    ).run(hash15);
    db.prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
       VALUES ('t15', ?, 'queued', 'auto', 0)`,
    ).run(hash15);
    expect(
      db.prepare(`SELECT plan_kind FROM transcribe_tasks WHERE id = 't15'`).get(),
    ).toEqual({ plan_kind: 'segment' });

    for (const table of ['translate_tasks', 'polish_tasks', 'insight_tasks']) {
      expect(columns(db, table)).toContain('invocation_spec_json');
      expect(columns(db, table)).toContain('invocation_fingerprint');
    }
  });

  it('allows multiple insight rows for one video/language when invocation fingerprints differ', () => {
    const db = getDb();
    const hash = 'd'.repeat(64);
    db.prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES (?, 'v.mp4', '.mp4', 1, 0, 0)`,
    ).run(hash);

    db.prepare(
      `INSERT INTO insight_tasks
       (id, video_sha, status, model, ui_language, invocation_spec_json, invocation_fingerprint, created_at)
       VALUES
       ('i1', ?, 'done', '8b', 'en', '{}', 'fp-1', 0),
       ('i2', ?, 'done', '4b', 'en', '{}', 'fp-2', 1)`,
    ).run(hash, hash);

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM insight_tasks WHERE video_sha = ? AND ui_language = 'en'`)
        .get(hash),
    ).toEqual({ n: 2 });
  });

  it('re-creates polish_tasks when user_version 14 was stamped by a foreign build', () => {
    // Simulates the prototype-polluted DB: version already 14 (so step 14
    // is skipped), polish_tasks absent.
    seedRawDb(process.env.SUBCAST_HOME!, (db) => {
      db.exec(VIDEOS_V13);
      db.pragma('user_version = 14');
    });

    const db = getDb();

    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'polish_tasks'`).all(),
    ).toHaveLength(1);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_polish_status'`).all(),
    ).toHaveLength(1);

    // The exact query /api/queue/list runs must no longer throw.
    expect(() =>
      db
        .prepare(
          `SELECT t.id, t.video_sha, t.status, v.original_name
           FROM polish_tasks t
           LEFT JOIN videos v ON v.sha256 = t.video_sha`,
        )
        .all(),
    ).not.toThrow();

    // Round-trip a row to prove the FK + UNIQUE constraints match step 14.
    const now = Date.now();
    const hash = 'a'.repeat(64);
    db.prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES (?, 'clip.mp4', '.mp4', 1, ?, ?)`,
    ).run(hash, now, now);
    db.prepare(
      `INSERT INTO polish_tasks (id, video_sha, status, model, created_at)
       VALUES ('p1', ?, 'queued', 'qwen3:8b', ?)`,
    ).run(hash, now);
    expect(
      db.prepare(`SELECT status FROM polish_tasks WHERE id = 'p1'`).get(),
    ).toEqual({ status: 'queued' });
  });

  it('self-heals plan_kind when a foreign build already stamped user_version 16', () => {
    seedRawDb(process.env.SUBCAST_HOME!, (db) => {
      db.exec(VIDEOS_V13);
      db.exec(`
        CREATE TABLE transcribe_tasks (
          id              TEXT PRIMARY KEY,
          video_sha       TEXT NOT NULL REFERENCES videos(sha256),
          status          TEXT NOT NULL,
          model           TEXT NOT NULL,
          language        TEXT,
          total_chunks    INTEGER,
          done_chunks     INTEGER NOT NULL DEFAULT 0,
          error_msg       TEXT,
          error_code      TEXT,
          created_at      INTEGER NOT NULL,
          completed_at    INTEGER
        );
      `);
      db.pragma('user_version = 16');
    });

    const db = getDb();
    expect(columns(db, 'transcribe_tasks')).toContain('plan_kind');

    const hash = 'e'.repeat(64);
    db.prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES (?, 'clip.mp4', '.mp4', 1, 0, 0)`,
    ).run(hash);
    db.prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
       VALUES ('t16', ?, 'queued', 'auto', 0)`,
    ).run(hash);
    expect(
      db.prepare(`SELECT plan_kind FROM transcribe_tasks WHERE id = 't16'`).get(),
    ).toEqual({ plan_kind: 'segment' });
  });
});

describe('getDb() migration failure handling', () => {
  it('throws the real migration error and does not cache a broken handle', () => {
    // user_version 5 but videos already carries display_name → step 6's
    // bare ALTER throws "duplicate column name".
    seedRawDb(process.env.SUBCAST_HOME!, (db) => {
      db.exec(VIDEOS_V13);
      db.pragma('user_version = 5');
    });

    // First call surfaces the actual cause instead of a downstream
    // "no such table" from some unrelated endpoint.
    expect(() => getDb()).toThrow(/duplicate column name: display_name/);

    // And the failure must not be cached: the next call retries the
    // migration (same root-cause error) rather than silently returning
    // a handle over an unmigrated schema.
    expect(() => getDb()).toThrow(/duplicate column name: display_name/);
  });
});
