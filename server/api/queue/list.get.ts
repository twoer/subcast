/* SPDX-License-Identifier: Apache-2.0 */
// Aggregated queue snapshot for the index page panel. Returns active +
// recent (last 24h) tasks across transcribe, translate, and insight queues.
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';
import type {
  InsightTaskRow,
  TranscribeTaskRow,
  TranslateTaskRow,
} from '../../types/db';

interface DiarizeJoinRow {
  id: string;
  video_sha: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  raw_speaker_count: number | null;
  final_speaker_count: number | null;
  top_k: number | null;
  created_at: number;
  error_msg: string | null;
  error_code: string | null;
  original_name: string | null;
  display_name: string | null;
}

// LEFT JOIN on videos: the video may have been deleted, so the joined
// columns are nullable even though the underlying VideoRow types aren't.
type VideoJoinFields = {
  original_name: string | null;
  display_name: string | null;
};

type TranscribeJoinRow =
  & Pick<TranscribeTaskRow, 'id' | 'video_sha' | 'status' | 'model' | 'total_chunks' | 'done_chunks' | 'created_at' | 'error_msg' | 'error_code'>
  & VideoJoinFields;

type TranslateJoinRow =
  & Pick<TranslateTaskRow, 'id' | 'video_sha' | 'target_lang' | 'status' | 'model' | 'progress_pct' | 'priority' | 'created_at' | 'error_msg' | 'error_code'>
  & VideoJoinFields;

type InsightJoinRow =
  & Pick<InsightTaskRow, 'id' | 'video_sha' | 'status' | 'model' | 'ui_language' | 'created_at' | 'error_msg' | 'error_code'>
  & VideoJoinFields;

interface QueueItem {
  kind: 'transcribe' | 'translate' | 'insight' | 'diarize';
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
  /** diarize-only: K passed to consolidate. */
  topK?: number | null;
  /** diarize-only: final speaker count after consolidate. */
  finalSpeakerCount?: number | null;
  createdAt: number;
  errorMsg?: string | null;
  errorCode?: string | null;
}

export default defineEventHandler(() => {
  const db = getDb();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  const transcribes = db
    .prepare(
      `SELECT t.id, t.video_sha, t.status, t.model, t.total_chunks, t.done_chunks,
              t.created_at, t.error_msg, t.error_code, v.original_name, v.display_name
       FROM transcribe_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.created_at DESC`,
    )
    .all(cutoff) as TranscribeJoinRow[];

  const translates = db
    .prepare(
      `SELECT t.id, t.video_sha, t.target_lang, t.status, t.model, t.progress_pct,
              t.priority, t.created_at, t.error_msg, t.error_code, v.original_name, v.display_name
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

  const diarizes = db
    .prepare(
      `SELECT t.id, t.video_sha, t.status, t.raw_speaker_count, t.final_speaker_count,
              t.top_k, t.created_at, t.error_msg, t.error_code,
              v.original_name, v.display_name
       FROM diarize_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('pending','running') OR t.created_at > ?
       ORDER BY t.created_at DESC`,
    )
    .all(cutoff) as DiarizeJoinRow[];

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
      errorCode: t.error_code,
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
      errorCode: t.error_code,
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
      errorCode: t.error_code,
    });
  }
  for (const t of diarizes) {
    items.push({
      kind: 'diarize',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      // diarize doesn't pick a "model" the way whisper/qwen do — it's the
      // fixed campplus pack. Use a constant so the home tasks panel has
      // something stable to render in the model column.
      model: 'sherpa-onnx · campplus',
      progressPct: t.status === 'done' ? 100 : 0,
      topK: t.top_k,
      finalSpeakerCount: t.final_speaker_count,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
      errorCode: t.error_code,
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

  // Diagnostic: when the API returns 0 items, capture enough context to
  // tell apart "DB really has no recent tasks" vs "wrong DB / stale snapshot".
  // Compare totals (unfiltered) to filtered counts to spot 24h-cutoff misses
  // and to confirm the process is reading the DB you expect.
  if (items.length === 0) {
    const totals = {
      transcribe: (db.prepare(`SELECT COUNT(*) AS n FROM transcribe_tasks`).get() as { n: number }).n,
      translate: (db.prepare(`SELECT COUNT(*) AS n FROM translate_tasks`).get() as { n: number }).n,
      insight: (db.prepare(`SELECT COUNT(*) AS n FROM insight_tasks`).get() as { n: number }).n,
    };
    logEvent({
      level: 'info',
      event: 'queue_list_empty',
      cutoffMs: cutoff,
      nowMs: Date.now(),
      home: SUBCAST_PATHS.home,
      totals,
      filtered: { transcribe: transcribes.length, translate: translates.length, insight: insights.length },
    });
  }

  return { items };
});
