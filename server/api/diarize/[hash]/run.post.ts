/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/diarize/[hash]/run — Manual trigger for the full diarize
 * pipeline.
 *
 * Phase 1 doesn't yet auto-enqueue diarize after transcribe completes.
 * For now the player kicks off diarize explicitly after observing
 * transcribe is done — this endpoint creates the diarize_tasks row if
 * needed and runs the pipeline.
 *
 * 412s if the video has no completed transcribe output yet. Partial
 * chunks from a still-running transcribe are not enough because diarize
 * must cover the whole media, not the first few emitted chunks.
 *
 * Body: { topK?: number } — initial K for Stage 2. Default from
 *   CONSOLIDATE_DEFAULTS (= 2).
 *
 * Starts the long-running pipeline in the background and returns
 * immediately. UI follows progress by polling GET /api/diarize/[hash].
 */

import { defineEventHandler, getRouterParam, readBody, createError } from 'h3';
import { getDb } from '../../../utils/db';
import { runDiarize } from '../../../utils/diarize/diarize';
import { ensureDiarizeTask, TranscribeNotDoneError } from '../../../utils/diarize/tasks';
import { logEvent } from '../../../utils/log';
import { isValidHash } from '../../../utils/validate';

interface ReqBody {
  topK?: number;
}

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  if (!isValidHash(hash)) throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });

  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? ({} as ReqBody);
  const db = getDb();

  let taskId: string;
  let alreadyRunning: boolean;
  try {
    const task = ensureDiarizeTask(hash, { topK: body.topK });
    taskId = task.taskId;
    alreadyRunning = task.alreadyRunning;
  } catch (err) {
    if (err instanceof TranscribeNotDoneError) {
      throw createError({
        statusCode: 412,
        statusMessage: 'TRANSCRIBE_NOT_DONE',
        data: { message: 'Diarize requires a completed transcribe task with chunks.' },
      });
    }
    throw err;
  }

  if (alreadyRunning) {
    throw createError({
      statusCode: 409,
      statusMessage: 'ALREADY_RUNNING',
      data: { taskId },
    });
  }

  // Fire-and-forget: kick off the pipeline in the background and return
  // 202 immediately so the HTTP client doesn't block for 5-7 minutes.
  // Frontend polls GET /api/diarize/[hash] every few seconds to follow
  // the status row.
  //
  // Errors are caught here and persisted to diarize_tasks.error_msg so
  // the next status poll picks up the failure. No promise leaks: we
  // intentionally don't await; the .catch handler is the safety net.
  void runDiarize(hash, taskId, { topK: body.topK }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logEvent({
      level: 'error',
      event: 'diarize_run_failed',
      videoSha: hash,
      taskId,
      message,
      stack,
    });
    try {
      db.prepare(
        `UPDATE diarize_tasks SET status='failed', error_msg=?, completed_at=?
         WHERE id=? AND status='running'`,
      ).run(message, Date.now(), taskId);
    } catch {
      /* DB might be in a weird state if the failure was DB-related; swallow */
    }
  });

  return { ok: true as const, taskId, status: 'running' as const };
});
