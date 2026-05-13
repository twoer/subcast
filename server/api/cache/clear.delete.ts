/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';

export default defineEventHandler(async () => {
  // Wipe video files + cache dirs; keep logs and the sqlite schema (settings
  // included). Tasks rows are dropped because their referenced videos go away.
  if (existsSync(SUBCAST_PATHS.videos)) {
    for (const f of readdirSync(SUBCAST_PATHS.videos)) {
      await rm(join(SUBCAST_PATHS.videos, f), { force: true });
    }
  }
  if (existsSync(SUBCAST_PATHS.cache)) {
    for (const d of readdirSync(SUBCAST_PATHS.cache)) {
      await rm(join(SUBCAST_PATHS.cache, d), { recursive: true, force: true });
    }
  }
  const db = getDb();
  // Single transaction so a crash mid-wipe doesn't leave dangling rows
  // referencing already-deleted videos.
  db.transaction(() => {
    db.prepare(`DELETE FROM chunks`).run();
    db.prepare(`DELETE FROM subtitles`).run();
    db.prepare(`DELETE FROM transcribe_tasks`).run();
    db.prepare(`DELETE FROM translate_tasks`).run();
    db.prepare(`DELETE FROM insight_tasks`).run();
    db.prepare(`DELETE FROM videos`).run();
  })();
  logEvent({ level: 'info', event: 'cache_clear_all' });
  return { ok: true };
});
