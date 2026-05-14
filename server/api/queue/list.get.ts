/* SPDX-License-Identifier: AGPL-3.0-or-later */
// Aggregated queue snapshot for the index page panel. Returns active +
// recent (last 24h) tasks across transcribe, translate, and insight queues.
import { getDb } from '../../utils/db';
import type {
  InsightTaskRow,
  TranscribeTaskRow,
  TranslateTaskRow,
} from '../../types/db';

// LEFT JOIN on videos: the video may have been deleted, so the joined
// columns are nullable even though the underlying VideoRow types aren't.
type VideoJoinFields = {
  original_name: string | null;
  display_name: string | null;
};

type TranscribeJoinRow =
  & Pick<TranscribeTaskRow, 'id' | 'video_sha' | 'status' | 'model' | 'total_chunks' | 'done_chunks' | 'created_at' | 'error_msg'>
  & VideoJoinFields;

type TranslateJoinRow =
  & Pick<TranslateTaskRow, 'id' | 'video_sha' | 'target_lang' | 'status' | 'model' | 'progress_pct' | 'priority' | 'created_at' | 'error_msg'>
  & VideoJoinFields;

type InsightJoinRow =
  & Pick<InsightTaskRow, 'id' | 'video_sha' | 'status' | 'model' | 'ui_language' | 'created_at' | 'error_msg'>
  & VideoJoinFields;

interface QueueItem {
  kind: 'transcribe' | 'translate' | 'insight';
  id: string;
  videoSha: string;
  videoName: string;
  status: string;
  model: string;
  progressPct: number;
  totalChunks?: number | null;
  doneChunks?: number;
  targetLang?: string;
  uiLanguage?: 'zh-CN' | 'en';
  createdAt: number;
  errorMsg?: string | null;
}

export default defineEventHandler(() => {
  const db = getDb();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  const transcribes = db
    .prepare(
      `SELECT t.id, t.video_sha, t.status, t.model, t.total_chunks, t.done_chunks,
              t.created_at, t.error_msg, v.original_name, v.display_name
       FROM transcribe_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.created_at DESC`,
    )
    .all(cutoff) as TranscribeJoinRow[];

  const translates = db
    .prepare(
      `SELECT t.id, t.video_sha, t.target_lang, t.status, t.model, t.progress_pct,
              t.priority, t.created_at, t.error_msg, v.original_name, v.display_name
       FROM translate_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.priority DESC, t.created_at DESC`,
    )
    .all(cutoff) as TranslateJoinRow[];

  const insights = db
    .prepare(
      `SELECT t.id, t.video_sha, t.status, t.model, t.ui_language, t.created_at,
              t.error_msg, v.original_name, v.display_name
       FROM insight_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.created_at DESC`,
    )
    .all(cutoff) as InsightJoinRow[];

  const items: QueueItem[] = [];
  for (const t of transcribes) {
    const pct = t.total_chunks
      ? Math.round((t.done_chunks / t.total_chunks) * 100)
      : 0;
    items.push({
      kind: 'transcribe',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      model: t.model,
      progressPct: pct,
      totalChunks: t.total_chunks,
      doneChunks: t.done_chunks,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
    });
  }
  for (const t of translates) {
    items.push({
      kind: 'translate',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      model: t.model,
      progressPct: t.progress_pct,
      targetLang: t.target_lang,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
    });
  }
  for (const t of insights) {
    items.push({
      kind: 'insight',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      model: t.model,
      progressPct: t.status === 'done' ? 100 : 0,
      uiLanguage: t.ui_language,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
    });
  }
  // Active (queued/running) first, then recent finished
  const order = (s: string) =>
    s === 'running' ? 0 : s === 'queued' ? 1 : 2;
  items.sort((a, b) => {
    const oa = order(a.status), ob = order(b.status);
    if (oa !== ob) return oa - ob;
    return b.createdAt - a.createdAt;
  });
  return { items };
});
