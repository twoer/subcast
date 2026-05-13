/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { getDb } from '../../utils/db';
import { abortTask } from '../../utils/insightTasks';
import type { InsightTaskRow } from '../../types/db';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_ID' });

  const db = getDb();
  const row = db
    .prepare('SELECT status FROM insight_tasks WHERE id = ?')
    .get(id) as Pick<InsightTaskRow, 'status'> | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: 'TASK_NOT_FOUND' });

  // Abort the live generation if it's still running. The task manager
  // will mark the row as 'canceled' and notify subscribers; we also
  // update the DB here so a no-op (stale row, restart) still reflects
  // the user's intent.
  const aborted = abortTask(id);
  if (!aborted && (row.status === 'running' || row.status === 'queued')) {
    db.prepare(`UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`).run(
      Date.now(),
      id,
    );
  }
  return { ok: true, aborted };
});
