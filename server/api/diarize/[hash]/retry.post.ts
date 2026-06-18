/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/diarize/[hash]/retry — Full Stage 1 + Stage 2 rerun (~5-7
 * min on 1 h video).
 *
 * Wipes display_names per Q5 (the user already accepted the warning
 * dialog before reaching this endpoint). Clears raw speaker cache +
 * speaker timeline + task aggregates, sets task back to pending,
 * then starts the full pipeline in the background.
 *
 * Body: { topK?: number, mergeThreshold?: number }
 *   The K to use for the post-Stage-2 consolidation. If omitted,
 *   defaults to whatever was set previously (or CONSOLIDATE_DEFAULTS.topK).
 *
 * The endpoint returns immediately; the frontend polls GET
 * /api/diarize/[hash] for progress.
 */

import { defineEventHandler, getRouterParam, readBody, createError } from 'h3';
import { randomUUID } from 'node:crypto';
import { getDb } from '../../../utils/db';
import { runDiarize } from '../../../utils/diarize/diarize';
import { hasCompletedTranscribeChunks } from '../../../utils/diarize/readiness';
import { logEvent } from '../../../utils/log';
import { isValidHash } from '../../../utils/validate';

interface ReqBody {
  topK?: number;
  mergeThreshold?: number;
}

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  if (!isValidHash(hash)) throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });

  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? ({} as ReqBody);
  const db = getDb();

  const video = db
    .prepare('SELECT 1 AS ok FROM videos WHERE sha256 = ? AND deleted_at IS NULL')
    .get(hash) as { ok: number } | undefined;
  if (!video) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  if (!hasCompletedTranscribeChunks(db, hash)) {
    throw createError({
      statusCode: 412,
      statusMessage: 'TRANSCRIBE_NOT_DONE',
      data: { message: 'Diarize retry requires a completed transcribe task with chunks.' },
    });
  }

  // Wipe prior state (Q5: also drops user-renamed display_names because
  // the warning dialog already informed the user).
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM speakers WHERE video_sha = ?').run(hash);
    db.prepare('DELETE FROM diarize_raw_speakers WHERE video_sha = ?').run(hash);
    db.prepare(
      `UPDATE chunks SET speaker_timeline = NULL, raw_speaker_timeline = NULL
       WHERE task_id IN (SELECT id FROM transcribe_tasks WHERE video_sha = ?)`,
    ).run(hash);
    // UPSERT diarize_tasks row to pending. UNIQUE(video_sha) per Q7a.
    const existing = db
      .prepare('SELECT id FROM diarize_tasks WHERE video_sha = ?')
      .get(hash) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE diarize_tasks
         SET status='pending', raw_speaker_count=NULL, final_speaker_count=NULL,
             unknown_duration_s=NULL, unknown_ratio=NULL, top_k=NULL, mode=NULL,
             error_code=NULL, error_msg=NULL, completed_at=NULL
         WHERE id=?`,
      ).run(existing.id);
    } else {
      db.prepare(
        `INSERT INTO diarize_tasks (id, video_sha, status, created_at)
         VALUES (?, ?, 'pending', ?)`,
      ).run(randomUUID(), hash, Date.now());
    }
    db.prepare('UPDATE videos SET has_diarization = 0 WHERE sha256 = ?').run(hash);
  });
  tx();

  const taskId = (db
    .prepare('SELECT id FROM diarize_tasks WHERE video_sha = ?')
    .get(hash) as { id: string }).id;

  void runDiarize(hash, taskId, {
      topK: body.topK,
      mergeThreshold: body.mergeThreshold,
    }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logEvent({
      level: 'error',
      event: 'diarize_retry_failed',
      videoSha: hash,
      taskId,
      message,
      stack,
    });
    db.prepare(
      `UPDATE diarize_tasks SET status='failed', error_msg=?, completed_at=?
       WHERE id=? AND status='running'`,
    ).run(message, Date.now(), taskId);
  });

  return { ok: true as const, taskId, status: 'running' as const };
});
