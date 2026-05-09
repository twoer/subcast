import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }
  const db = getDb();
  const row = db
    .prepare(`SELECT ext FROM videos WHERE sha256 = ?`)
    .get(hash) as { ext: string } | undefined;
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  const videoPath = join(SUBCAST_PATHS.videos, `${hash}${row.ext}`);
  const cacheDir = join(SUBCAST_PATHS.cache, hash);
  if (existsSync(videoPath)) await rm(videoPath, { force: true });
  if (existsSync(cacheDir)) await rm(cacheDir, { recursive: true, force: true });
  // Cascade delete: chunks → transcribe_tasks; subtitles + translate_tasks; videos.
  db.prepare(
    `DELETE FROM chunks WHERE task_id IN (SELECT id FROM transcribe_tasks WHERE video_sha = ?)`,
  ).run(hash);
  db.prepare(`DELETE FROM transcribe_tasks WHERE video_sha = ?`).run(hash);
  db.prepare(`DELETE FROM translate_tasks WHERE video_sha = ?`).run(hash);
  db.prepare(`DELETE FROM subtitles WHERE video_sha = ?`).run(hash);
  db.prepare(`DELETE FROM videos WHERE sha256 = ?`).run(hash);
  logEvent({ level: 'info', event: 'cache_delete_one', sha: hash });
  return { ok: true, hash };
});
