/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';
import { getTaskByHash, abortTask } from '../../utils/insightTasks';
import { isValidHash } from '../../utils/validate';
import type { VideoRow } from '../../types/db';

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  if (!isValidHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }
  const db = getDb();
  const row = db
    .prepare(`SELECT ext FROM videos WHERE sha256 = ?`)
    .get(hash) as Pick<VideoRow, 'ext'> | undefined;
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  // Abort any in-flight insight generation before tearing the cache dir down,
  // otherwise it would try to write into a directory we're about to delete.
  const running = getTaskByHash(hash);
  if (running?.status === 'running') abortTask(running.id);
  const videoPath = join(SUBCAST_PATHS.videos, `${hash}${row.ext}`);
  const cacheDir = join(SUBCAST_PATHS.cache, hash);
  if (existsSync(videoPath)) await rm(videoPath, { force: true });
  if (existsSync(cacheDir)) await rm(cacheDir, { recursive: true, force: true });
  // Cascade delete in a single transaction so a crash between statements
  // can't leave orphan chunks / subtitles / task rows.
  db.transaction(() => {
    db.prepare(
      `DELETE FROM chunks WHERE task_id IN (SELECT id FROM transcribe_tasks WHERE video_sha = ?)`,
    ).run(hash);
    db.prepare(`DELETE FROM transcribe_tasks WHERE video_sha = ?`).run(hash);
    db.prepare(`DELETE FROM translate_tasks WHERE video_sha = ?`).run(hash);
    db.prepare(`DELETE FROM subtitles WHERE video_sha = ?`).run(hash);
    db.prepare(`DELETE FROM insight_tasks WHERE video_sha = ?`).run(hash);
    db.prepare(`DELETE FROM videos WHERE sha256 = ?`).run(hash);
  })();
  logEvent({ level: 'info', event: 'cache_delete_one', sha: hash });
  return { ok: true, hash };
});
