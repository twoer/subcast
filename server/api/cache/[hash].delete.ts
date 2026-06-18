/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';
import { deleteVideoGraph } from '../../utils/mediaGraphDelete';
import { llmQueue } from '../../utils/queue';
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
  // Cancel any in-flight insight tasks before tearing the cache dir down,
  // otherwise they would try to write into a directory we're about to delete.
  const runningInsights = db
    .prepare(
      `SELECT id FROM insight_tasks
       WHERE video_sha = ? AND status IN ('queued','running')`,
    )
    .all(hash) as { id: string }[];
  for (const row of runningInsights) {
    llmQueue.cancel(row.id);
  }
  const videoPath = join(SUBCAST_PATHS.videos, `${hash}${row.ext}`);
  const cacheDir = join(SUBCAST_PATHS.cache, hash);
  if (existsSync(videoPath)) await rm(videoPath, { force: true });
  if (existsSync(cacheDir)) await rm(cacheDir, { recursive: true, force: true });
  // Cascade delete in a single transaction so a crash between statements
  // can't leave orphan chunks / subtitles / task rows.
  db.transaction(() => {
    deleteVideoGraph(db, hash);
  })();
  logEvent({ level: 'info', event: 'cache_delete_one', sha: hash });
  return { ok: true, hash };
});
