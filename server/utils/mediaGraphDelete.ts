/* SPDX-License-Identifier: Apache-2.0 */
import type Database from 'better-sqlite3';

/**
 * Centralized deletion for DB rows that hang off videos.sha256.
 *
 * Keep this list in one place. Several APIs need to tear down the same graph
 * (single delete, retry transcription, clear-all), and historical user DBs may
 * still contain legacy tables that current migrations no longer create.
 *
 * Tables fall into two shapes:
 *  - simple: a single `video_sha` column FK→videos(sha256)
 *  - dual-shaft: `source_video_sha` AND/OR `output_video_sha` FK→videos(sha256)
 *    (used by dub_tasks / dub_variants / video_export_tasks, where a derived
 *    video references the original it was made from).
 */

interface TableSpec {
  name: string;
  // Columns that FK to videos(sha256). At least one must be present for the
  // single-video path; clear-all doesn't use them (it wipes the whole table).
  videoColumns?: string[];
}

// Simple dependents: one video_sha column. Order doesn't matter within this
// group (they don't FK each other), but they must all be deleted before
// videos.
const SIMPLE_VIDEO_DEPENDENTS: TableSpec[] = [
  { name: 'subtitles', videoColumns: ['video_sha'] },
  { name: 'transcribe_tasks', videoColumns: ['video_sha'] },
  { name: 'translate_tasks', videoColumns: ['video_sha'] },
  { name: 'insight_tasks', videoColumns: ['video_sha'] },
  { name: 'speakers', videoColumns: ['video_sha'] },
  { name: 'diarize_raw_speakers', videoColumns: ['video_sha'] },
  { name: 'diarize_tasks', videoColumns: ['video_sha'] },
  // Legacy/prototype knowledge QA — may exist in real user DBs that opened
  // a prototype build. The FTS5 shadow tables (knowledge_chunks_fts*) don't
  // FK videos so they're harmless to leave behind.
  { name: 'knowledge_chunks', videoColumns: ['video_sha'] },
];

// Dual-shaft dependents: reference videos via source_video_sha and/or
// output_video_sha. Ordered parent→child where they FK each other.
const DUAL_SHAFT_DEPENDENTS: TableSpec[] = [
  // dub_segments → dub_tasks (task_id, ON DELETE CASCADE).
  // Must delete segments first, then tasks, then variants.
  { name: 'dub_segments' }, // FK dub_tasks, not videos directly
  { name: 'dub_tasks', videoColumns: ['source_video_sha', 'output_video_sha'] },
  { name: 'dub_variants', videoColumns: ['source_video_sha', 'output_video_sha'] },
  { name: 'video_export_tasks', videoColumns: ['source_video_sha', 'output_video_sha'] },
];

// Tables that don't FK videos but should be cleared on bulk-wipe for
// consistency (knowledge ask results, QA history). Single-video delete
// leaves them (they're keyed by their own ids, not video).
const BULK_ONLY_TABLES = ['knowledge_ask_tasks', 'qa_history'] as const;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

/**
 * Delete all rows that reference a single video (by hash) across every
 * dependent table — simple and dual-shaft. Call before deleting the video row.
 */
function deleteDependentsForVideo(db: Database.Database, hash: string): void {
  // Simple: DELETE ... WHERE video_sha = ?
  for (const { name } of SIMPLE_VIDEO_DEPENDENTS) {
    if (!tableExists(db, name)) continue;
    db.prepare(`DELETE FROM ${name} WHERE video_sha = ?`).run(hash);
  }
  // Dual-shaft: delete child first (dub_segments via task_id subquery on
  // dub_tasks that reference this video), then parents.
  if (tableExists(db, 'dub_segments')) {
    db.prepare(
      `DELETE FROM dub_segments WHERE task_id IN (SELECT id FROM dub_tasks WHERE source_video_sha = ? OR output_video_sha = ?)`,
    ).run(hash, hash);
  }
  for (const { name, videoColumns } of DUAL_SHAFT_DEPENDENTS) {
    if (!tableExists(db, name) || !videoColumns) continue;
    const cols = videoColumns.map((c) => `${c} = ?`).join(' OR ');
    db.prepare(`DELETE FROM ${name} WHERE ${cols}`).run(...videoColumns.map(() => hash));
  }
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
  // chunks FK transcribe_tasks(id), so delete before transcribe_tasks.
  db.prepare(
    `DELETE FROM chunks WHERE task_id IN (SELECT id FROM transcribe_tasks WHERE video_sha = ?)`,
  ).run(hash);
  deleteDependentsForVideo(db, hash);
  // batch_items FK videos; remove before deleting the video row.
  db.prepare(`DELETE FROM batch_items WHERE video_sha = ?`).run(hash);
  db.prepare(
    `DELETE FROM batch_jobs
     WHERE NOT EXISTS (
       SELECT 1 FROM batch_items WHERE batch_items.batch_id = batch_jobs.id
     )`,
  ).run();
  if (!opts.keepVideo) {
    // Derivative videos (dub output, export output) reference the source
    // video via videos.source_video_sha. They must go before the source.
    // Guard with column-exists check: old DBs may predate the column.
    const hasSourceCol = db
      .prepare(`SELECT 1 FROM pragma_table_info('videos') WHERE name = 'source_video_sha'`)
      .get();
    if (hasSourceCol) {
      db.prepare(`DELETE FROM videos WHERE source_video_sha = ?`).run(hash);
    }
    db.prepare(`DELETE FROM videos WHERE sha256 = ?`).run(hash);
  }
}

/**
 * Delete all media rows while preserving settings and logs.
 *
 * The caller (cache/clear.delete.ts) MUST toggle `PRAGMA foreign_keys = OFF`
 * on the connection BEFORE starting the transaction that wraps this call —
 * SQLite silently ignores PRAGMA foreign_keys inside an open transaction.
 * With FK checks OFF the bulk wipe can run in any order; the end state has
 * all dependent tables empty so no dangling FK rows remain.
 */
export function clearMediaGraph(db: Database.Database): void {
  // Dual-shaft children first (dub_segments before dub_tasks).
  for (const { name } of DUAL_SHAFT_DEPENDENTS) {
    if (tableExists(db, name)) db.prepare(`DELETE FROM ${name}`).run();
  }
  db.prepare(`DELETE FROM batch_items`).run();
  db.prepare(`DELETE FROM batch_jobs`).run();
  db.prepare(`DELETE FROM chunks`).run();
  for (const { name } of SIMPLE_VIDEO_DEPENDENTS) {
    if (tableExists(db, name)) db.prepare(`DELETE FROM ${name}`).run();
  }
  for (const name of BULK_ONLY_TABLES) {
    if (tableExists(db, name)) db.prepare(`DELETE FROM ${name}`).run();
  }
  // Delete videos last (everything else FKs to it).
  db.prepare(`DELETE FROM videos`).run();
}
