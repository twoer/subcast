/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Read-side view of the transcription "source" for the transcribe→LLM
 * pipeline (P6). Both queues import these helpers — keeping them in a
 * leaf module avoids an llmQueue ↔ transcribeQueue import cycle.
 *
 * Identity guarantee: original.vtt is written at completion as a plain
 * flatMap+serialize of the chunks rows (see transcribeQueue's completion
 * block), so cues read here are byte-identical to the batch-mode input
 * the LLM workers used pre-P6. Speaker labels are merged only at export
 * time and never touch cue text, so streaming LLM output stays
 * alignable with the final original.vtt.
 */

import { getDb } from './db';
import { SUPER_BATCH_SIZE } from './translate';
import type { Cue } from './vtt';

/** Latest queued/running transcribe task for a video, if any. */
export function runningTranscribeTask(
  videoSha: string,
): { id: string; status: string; totalChunks: number } | undefined {
  return getDb()
    .prepare(
      `SELECT id, status, total_chunks AS totalChunks
       FROM transcribe_tasks
       WHERE video_sha = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(videoSha) as { id: string; status: string; totalChunks: number } | undefined;
}

export interface TranscriptSourceSnapshot {
  /** Every cue persisted so far, in chunk order. */
  cues: Cue[];
  /** Persisted chunk rows count (≈ the task's done_chunks). */
  doneChunks: number;
  totalChunks: number;
  /** False once the transcribe task reached any terminal state. */
  live: boolean;
}

/** Snapshot of everything a pipelined LLM worker needs from its source. */
export function readTranscriptSource(taskId: string): TranscriptSourceSnapshot {
  const db = getDb();
  const row = db
    .prepare(`SELECT status, total_chunks FROM transcribe_tasks WHERE id = ?`)
    .get(taskId) as { status: string; total_chunks: number | null } | undefined;
  const chunkRows = db
    .prepare(`SELECT cues_json FROM chunks WHERE task_id = ? ORDER BY chunk_idx ASC`)
    .all(taskId) as { cues_json: string }[];
  return {
    cues: chunkRows.flatMap((r) => JSON.parse(r.cues_json) as Cue[]),
    doneChunks: chunkRows.length,
    totalChunks: row?.total_chunks ?? 0,
    live: row?.status === 'queued' || row?.status === 'running',
  };
}

/**
 * Videos whose queued LLM work may start right now: finished
 * transcriptions (original subtitles row exists) plus live
 * transcriptions that have already produced at least one full
 * super-batch of cues (translate and polish both batch at 25). Tasks
 * for other shas stay parked in 'queued' — they are skipped by the
 * dequeue until their source catches up, or canceled wholesale if the
 * source fails (see LLMQueue.cancelTasksForSource).
 */
export function pipelineReadyShas(): Set<string> {
  const db = getDb();
  const ready = new Set<string>();
  for (const r of db
    .prepare(`SELECT video_sha FROM subtitles WHERE lang = 'original'`)
    .all() as { video_sha: string }[]) {
    ready.add(r.video_sha);
  }
  const live = db
    .prepare(
      `SELECT t.video_sha AS sha, SUM(json_array_length(c.cues_json)) AS cues
       FROM transcribe_tasks t JOIN chunks c ON c.task_id = t.id
       WHERE t.status = 'running'
       GROUP BY t.video_sha`,
    )
    .all() as { sha: string; cues: number | null }[];
  for (const r of live) {
    if ((r.cues ?? 0) >= SUPER_BATCH_SIZE) ready.add(r.sha);
  }
  return ready;
}
