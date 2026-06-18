/* SPDX-License-Identifier: Apache-2.0 */

/**
 * DELETE /api/queue/diarize/[id] — soft-cancel an in-flight diarize.
 *
 * The frontend's QueueList shows a cancel button on running tasks
 * and calls this endpoint. Without it the click 404s silently.
 *
 * Soft-cancel semantics: we flip the diarize_tasks row to status='failed'
 * with error_code='CANCELED' so the UI immediately reflects "this is no
 * longer running" and /run can reuse the same row (its 409 guard only
 * blocks 'running'/'pending'). The sherpa worker may keep running until
 * its current native call returns, but runDiarize checks the task row
 * before writing Stage 1/2 results and will not overwrite this canceled
 * marker. A future improvement is a tasks-to-workers map in diarize.ts
 * that this handler can call .terminate() on.
 */
import { getDb } from '../../../utils/db';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'MISSING_ID' });
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE diarize_tasks
         SET status='failed',
             error_code='CANCELED',
             error_msg='Canceled by user',
             completed_at=?
       WHERE id=? AND (status='running' OR status='pending')`,
    )
    .run(Date.now(), id);
  if (info.changes === 0) {
    throw createError({
      statusCode: 404,
      statusMessage: 'TASK_NOT_FOUND_OR_TERMINAL',
    });
  }
  return { ok: true, taskId: id };
});
