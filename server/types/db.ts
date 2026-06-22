/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Canonical row shapes for every `SELECT` against the SQLite schema in
 * `server/utils/db.ts`. Column names match the schema verbatim (snake_case);
 * call sites narrow with `Pick<VideoRow, 'ext'>` when only some columns are
 * selected.
 *
 * Keep these in sync with `migrate()` in db.ts — any column add/rename/drop
 * should update the matching interface here so TypeScript catches stale
 * call-site casts at compile time.
 */

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type InsightStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';
export type ChunkQuality = 'ok' | 'suspect';

export interface VideoRow {
  sha256: string;
  original_name: string;
  display_name: string | null;
  ext: string;
  size_bytes: number;
  duration_s: number | null;
  created_at: number;
  last_opened_at: number;
  deleted_at: number | null;
  /** Source URL for URL-imported videos; null for local-file uploads. */
  source_url: string | null;
}

export interface SubtitleRow {
  video_sha: string;
  lang: string;
  kind: string;
  cues_count: number;
  completed_at: number;
}

export interface TranscribeTaskRow {
  id: string;
  video_sha: string;
  status: TaskStatus;
  model: string;
  language: string | null;
  total_chunks: number | null;
  done_chunks: number;
  error_msg: string | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface ChunkRow {
  task_id: string;
  chunk_idx: number;
  start_ms: number;
  end_ms: number;
  cues_json: string;
  quality: ChunkQuality;
  retry_count: number;
}

export interface TranslateTaskRow {
  id: string;
  video_sha: string;
  target_lang: string;
  status: TaskStatus;
  model: string;
  progress_pct: number;
  priority: number;
  error_msg: string | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface SettingsRow {
  key: string;
  value: string;
}

export interface InsightTaskRow {
  id: string;
  video_sha: string;
  status: InsightStatus;
  model: string;
  ui_language: 'zh-CN' | 'en';
  error_msg: string | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}
