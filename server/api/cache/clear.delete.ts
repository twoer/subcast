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
  // Soft-delete the videos so /api/queue/list still resolves the videoName
  // for historical tasks, but they no longer appear in /api/cache/list.
  db.transaction(() => {
    db.prepare(
      `UPDATE videos SET deleted_at = ? WHERE deleted_at IS NULL`,
    ).run(Date.now());
  })();
  logEvent({ level: 'info', event: 'cache_clear_all' });
  return { ok: true };
});
