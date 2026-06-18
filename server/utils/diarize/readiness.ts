/* SPDX-License-Identifier: Apache-2.0 */
import type Database from 'better-sqlite3';

export function hasCompletedTranscribeChunks(
  db: Database.Database,
  videoSha: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok
       FROM transcribe_tasks t
       WHERE t.video_sha = ?
         AND t.status = 'completed'
         AND EXISTS (
           SELECT 1 FROM chunks c WHERE c.task_id = t.id
         )
       ORDER BY t.completed_at DESC
       LIMIT 1`,
    )
    .get(videoSha) as { ok: number } | undefined;
  return row !== undefined;
}
