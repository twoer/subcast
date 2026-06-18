/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';
import { clearMediaGraph } from '../../utils/mediaGraphDelete';
import { llmQueue, transcribeQueue } from '../../utils/queue';
import { HASH_RE } from '../../utils/validate';

export default defineEventHandler(async () => {
  // Wipe video files + cache dirs; keep logs and the sqlite schema (settings
  // included). Tasks rows are dropped because their referenced videos go away.
  await transcribeQueue.runPaused(async () => {
    await llmQueue.runPaused(async () => {
      await Promise.all([
        transcribeQueue.cancelAll('cache_clear_all'),
        llmQueue.cancelAll('cache_clear_all'),
      ]);

      if (existsSync(SUBCAST_PATHS.videos)) {
        for (const f of readdirSync(SUBCAST_PATHS.videos)) {
          await rm(join(SUBCAST_PATHS.videos, f), { force: true });
        }
      }
      if (existsSync(SUBCAST_PATHS.cache)) {
        for (const d of readdirSync(SUBCAST_PATHS.cache)) {
          if (!HASH_RE.test(d)) continue;
          await rm(join(SUBCAST_PATHS.cache, d), { recursive: true, force: true });
        }
      }
      const db = getDb();
      db.transaction(() => {
        clearMediaGraph(db);
      })();
    });
  });
  logEvent({ level: 'info', event: 'cache_clear_all' });
  return { ok: true };
});
