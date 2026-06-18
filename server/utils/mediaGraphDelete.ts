/* SPDX-License-Identifier: Apache-2.0 */
import type Database from 'better-sqlite3';

/**
 * Centralized deletion for DB rows that hang off videos.sha256.
 *
 * Keep this list in one place. Several APIs need to tear down the same graph
 * (single delete, retry transcription, clear-all), and historical user DBs may
 * still contain legacy tables that current migrations no longer create.
 */
const OPTIONAL_VIDEO_DEPENDENT_TABLES = [
  // Legacy diarization spike tables may exist in real user databases even
  // though current builds no longer create them. They FK to videos(sha256),
  // so video deletion must remove them before deleting videos.
  'diarize_raw_speakers',
  'speakers',
  'diarize_tasks',
  // Local knowledge QA prototype (see docs/plans/2026-05-17-local-knowledge-
  // qa.md) created `knowledge_chunks` with a FK to videos(sha256). The
  // feature wasn't merged but real user DBs that opened a prototype build
  // still carry the table — `clear all` would FOREIGN KEY-fail without
  // this entry. The FTS5 shadow tables (`knowledge_chunks_fts*`) don't FK
  // videos so they're harmless to leave behind.
  'knowledge_chunks',
] as const;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

function deleteOptionalVideoDependents(db: Database.Database, hash?: string): void {
  for (const table of OPTIONAL_VIDEO_DEPENDENT_TABLES) {
    if (!tableExists(db, table)) continue;
    if (hash) {
      db.prepare(`DELETE FROM ${table} WHERE video_sha = ?`).run(hash);
    } else {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  }
}

function deleteBatchDependents(db: Database.Database, hash?: string): void {
  if (hash) {
    db.prepare(`DELETE FROM batch_items WHERE video_sha = ?`).run(hash);
    db.prepare(
      `DELETE FROM batch_jobs
       WHERE NOT EXISTS (
         SELECT 1 FROM batch_items WHERE batch_items.batch_id = batch_jobs.id
       )`,
    ).run();
    return;
  }
  db.prepare(`DELETE FROM batch_items`).run();
  db.prepare(`DELETE FROM batch_jobs`).run();
}

/**
 * Delete derived rows for one video. By default the video row itself is also
 * removed; retry flows can keep it so display name and metadata survive.
 */
export function deleteVideoGraph(
  db: Database.Database,
  hash: string,
  opts: { keepVideo?: boolean } = {},
): void {
  db.prepare(
    `DELETE FROM chunks WHERE task_id IN (SELECT id FROM transcribe_tasks WHERE video_sha = ?)`,
  ).run(hash);
  db.prepare(`DELETE FROM transcribe_tasks WHERE video_sha = ?`).run(hash);
  db.prepare(`DELETE FROM translate_tasks WHERE video_sha = ?`).run(hash);
  db.prepare(`DELETE FROM subtitles WHERE video_sha = ?`).run(hash);
  db.prepare(`DELETE FROM insight_tasks WHERE video_sha = ?`).run(hash);
  deleteOptionalVideoDependents(db, hash);
  if (!opts.keepVideo) {
    deleteBatchDependents(db, hash);
    db.prepare(`DELETE FROM videos WHERE sha256 = ?`).run(hash);
  }
}

/** Delete all media rows while preserving settings and logs. */
export function clearMediaGraph(db: Database.Database): void {
  deleteBatchDependents(db);
  db.prepare(`DELETE FROM chunks`).run();
  db.prepare(`DELETE FROM subtitles`).run();
  db.prepare(`DELETE FROM transcribe_tasks`).run();
  db.prepare(`DELETE FROM translate_tasks`).run();
  db.prepare(`DELETE FROM insight_tasks`).run();
  deleteOptionalVideoDependents(db);
  db.prepare(`DELETE FROM videos`).run();
}
