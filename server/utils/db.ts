/* SPDX-License-Identifier: Apache-2.0 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveHome(): string {
  return process.env.SUBCAST_HOME ?? join(homedir(), '.subcast');
}

const SUBCAST_HOME = resolveHome();

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const home = resolveHome();
  const dbPath = join(home, 'data.sqlite');
  mkdirSync(home, { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        sha256          TEXT PRIMARY KEY,
        original_name   TEXT NOT NULL,
        ext             TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL,
        duration_s      REAL,
        created_at      INTEGER NOT NULL,
        last_opened_at  INTEGER NOT NULL
      );
    `);
    db.pragma('user_version = 1');
  }
  if (version < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subtitles (
        video_sha       TEXT NOT NULL REFERENCES videos(sha256),
        lang            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        cues_count      INTEGER NOT NULL,
        completed_at    INTEGER NOT NULL,
        PRIMARY KEY (video_sha, lang)
      );
    `);
    db.pragma('user_version = 2');
  }
  if (version < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcribe_tasks (
        id              TEXT PRIMARY KEY,
        video_sha       TEXT NOT NULL REFERENCES videos(sha256),
        status          TEXT NOT NULL,
        model           TEXT NOT NULL,
        language        TEXT,
        total_chunks    INTEGER,
        done_chunks     INTEGER NOT NULL DEFAULT 0,
        error_msg       TEXT,
        created_at      INTEGER NOT NULL,
        completed_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_transcribe_status ON transcribe_tasks(status);

      CREATE TABLE IF NOT EXISTS chunks (
        task_id         TEXT NOT NULL REFERENCES transcribe_tasks(id),
        chunk_idx       INTEGER NOT NULL,
        start_ms        INTEGER NOT NULL,
        end_ms          INTEGER NOT NULL,
        cues_json       TEXT NOT NULL,
        quality         TEXT NOT NULL DEFAULT 'ok',
        retry_count     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, chunk_idx)
      );
    `);
    db.pragma('user_version = 3');
  }
  if (version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS translate_tasks (
        id              TEXT PRIMARY KEY,
        video_sha       TEXT NOT NULL REFERENCES videos(sha256),
        target_lang     TEXT NOT NULL,
        status          TEXT NOT NULL,
        model           TEXT NOT NULL,
        progress_pct    INTEGER NOT NULL DEFAULT 0,
        priority        INTEGER NOT NULL DEFAULT 0,
        error_msg       TEXT,
        created_at      INTEGER NOT NULL,
        completed_at    INTEGER,
        UNIQUE (video_sha, target_lang)
      );
      CREATE INDEX IF NOT EXISTS idx_translate_priority ON translate_tasks(status, priority DESC, created_at ASC);
    `);
    db.pragma('user_version = 4');
  }
  if (version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key             TEXT PRIMARY KEY,
        value           TEXT NOT NULL
      );
    `);
    db.pragma('user_version = 5');
  }
  if (version < 6) {
    db.exec(`ALTER TABLE videos ADD COLUMN display_name TEXT`);
    db.pragma('user_version = 6');
  }
  if (version < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS insight_tasks (
        id              TEXT PRIMARY KEY,
        video_sha       TEXT NOT NULL REFERENCES videos(sha256),
        status          TEXT NOT NULL,
        model           TEXT NOT NULL,
        ui_language     TEXT NOT NULL,
        error_msg       TEXT,
        created_at      INTEGER NOT NULL,
        completed_at    INTEGER,
        UNIQUE (video_sha, ui_language)
      );
      CREATE INDEX IF NOT EXISTS idx_insight_status ON insight_tasks(status);
    `);
    db.pragma('user_version = 7');
  }
  if (version < 8) {
    // Soft-delete column on videos so cache delete preserves task history
    // for the home tasks panel. Re-upload of the same hash un-deletes the row.
    db.exec(`
      ALTER TABLE videos ADD COLUMN deleted_at INTEGER DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_videos_deleted_at ON videos(deleted_at);
    `);
    db.pragma('user_version = 8');
  }
  if (version < 9) {
    // Structured error code on each task table — mirrors the SSE error
    // frame's `{code, message}` shape so the home tasks panel can
    // friendly-render via i18n instead of dumping raw error strings.
    db.exec(`
      ALTER TABLE transcribe_tasks ADD COLUMN error_code TEXT DEFAULT NULL;
      ALTER TABLE translate_tasks ADD COLUMN error_code TEXT DEFAULT NULL;
      ALTER TABLE insight_tasks ADD COLUMN error_code TEXT DEFAULT NULL;
    `);
    db.pragma('user_version = 9');
  }
  if (version < 10) {
    // Advisory flag for the waveform feature. The on-disk
    // `<cache>/<sha>/waveform.json` remains the source of truth for
    // cache hits; this column is the future media-analysis pipeline's
    // "which videos are missing artifact X?" scan anchor, so we don't
    // have to revisit the schema when adding diarization / embeddings.
    // Default 0 — backfilled lazily by /api/waveform whenever an
    // existing video gets played for the first time after this migration.
    db.exec(`ALTER TABLE videos ADD COLUMN has_waveform INTEGER NOT NULL DEFAULT 0`);
    db.pragma('user_version = 10');
  }
  if (version < 11) {
    // Speaker diarization (docs/diarization-plan.md v1.5, two-stage pipeline).
    //
    // Stage 1 (sherpa raw) produces over-split output (e.g. 11 raw speakers
    // for a 2-person video) plus a centroid embedding per raw speaker that
    // we cache. Stage 2 (consolidation) groups raw speakers by cosine
    // similarity into Top-K final speakers (speaker_A / speaker_B / ...)
    // with the leftovers marked 'unknown'.
    //
    // Re-running Stage 2 with a different K (user picks 3 instead of 2) is
    // ~1-2 s because Stage 1's centroids are cached in diarize_raw_speakers.
    // No need to rerun sherpa.
    //
    // cues_json stays untouched per Q4 (cue splitting is render-time only);
    // speaker info lives in chunks.speaker_timeline and is joined in at
    // render / export time.
    db.exec(`
      -- 1a. Per-chunk speaker timeline (Stage 2 output, what UI consumes).
      --     JSON array, absolute time, sliced to each chunk's window:
      --       [{ startMs, endMs, speakerId: 'speaker_A' | 'speaker_B' | 'unknown' }]
      ALTER TABLE chunks ADD COLUMN speaker_timeline TEXT DEFAULT NULL;

      -- 1b. Per-chunk RAW speaker timeline (Stage 1 output, kept around so
      --     reconsolidate can re-cluster without rerunning sherpa).
      --     JSON array: [{ startMs, endMs, rawSpeaker: int }]
      ALTER TABLE chunks ADD COLUMN raw_speaker_timeline TEXT DEFAULT NULL;

      -- 2. Video-level speaker registry. speaker_id is the semantic label
      --    ('speaker_A' / 'speaker_B' / ...), NOT the raw integer. Display
      --    name is the user's rename (NULL falls back to i18n default).
      CREATE TABLE IF NOT EXISTS speakers (
        video_sha     TEXT NOT NULL REFERENCES videos(sha256),
        speaker_id    TEXT NOT NULL,
        display_name  TEXT,
        PRIMARY KEY (video_sha, speaker_id)
      );

      -- 3. Raw speaker centroid cache. Enables reconsolidate (Stage 2 only)
      --    without rerunning sherpa. 192-dim f32 vector from campplus.
      CREATE TABLE IF NOT EXISTS diarize_raw_speakers (
        video_sha       TEXT NOT NULL REFERENCES videos(sha256),
        raw_speaker     INTEGER NOT NULL,
        duration_s      REAL NOT NULL,
        segment_count   INTEGER NOT NULL,
        centroid_emb    BLOB NOT NULL,
        PRIMARY KEY (video_sha, raw_speaker)
      );

      -- 4. Task-level state. UNIQUE on video_sha — one active diarize per
      --    video at a time; retry = UPDATE same row (Q7a).
      CREATE TABLE IF NOT EXISTS diarize_tasks (
        id                   TEXT PRIMARY KEY,
        video_sha            TEXT NOT NULL REFERENCES videos(sha256),
        status               TEXT NOT NULL,
        raw_speaker_count    INTEGER,
        final_speaker_count  INTEGER,
        unknown_duration_s   REAL,
        unknown_ratio        REAL,
        top_k                INTEGER,
        mode                 TEXT,
        error_code           TEXT,
        error_msg            TEXT,
        created_at           INTEGER NOT NULL,
        completed_at         INTEGER,
        UNIQUE (video_sha)
      );
      CREATE INDEX IF NOT EXISTS idx_diarize_status ON diarize_tasks(status);

      -- 5. Advisory flag on videos (mirrors has_waveform pattern).
      ALTER TABLE videos ADD COLUMN has_diarization INTEGER NOT NULL DEFAULT 0;
    `);
    db.pragma('user_version = 11');
  }
  if (version < 12) {
    // Batch processing orchestration. These tables only track the user's
    // high-level workflow; actual transcription / translation / insight /
    // diarization work still runs through the existing task tables.
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_jobs (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        status          TEXT NOT NULL,
        preset          TEXT NOT NULL,
        options_json    TEXT NOT NULL,
        total_items     INTEGER NOT NULL DEFAULT 0,
        done_items      INTEGER NOT NULL DEFAULT 0,
        failed_items    INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        started_at      INTEGER,
        completed_at    INTEGER,
        error_msg       TEXT
      );

      CREATE TABLE IF NOT EXISTS batch_items (
        id               TEXT PRIMARY KEY,
        batch_id         TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
        video_sha        TEXT NOT NULL REFERENCES videos(sha256),
        status           TEXT NOT NULL,
        current_step     TEXT,
        step_status_json TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        started_at       INTEGER,
        completed_at     INTEGER,
        error_msg        TEXT,
        UNIQUE(batch_id, video_sha)
      );

      CREATE INDEX IF NOT EXISTS idx_batch_jobs_status
        ON batch_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_batch_items_batch
        ON batch_items(batch_id, status, created_at);
    `);
    db.pragma('user_version = 12');
  }
}

/**
 * Test-only: closes and clears the singleton DB handle. Do not call from
 * production code — any cached prepared statement held by other modules
 * will throw `SQLITE_MISUSE` on next use after this runs.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export const SUBCAST_PATHS = {
  home: SUBCAST_HOME,
  videos: join(SUBCAST_HOME, 'videos'),
  cache: join(SUBCAST_HOME, 'cache'),
  logs: join(SUBCAST_HOME, 'logs'),
  tmp: join(SUBCAST_HOME, 'tmp'),
} as const;
