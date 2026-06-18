/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defineEventHandler, getQuery, createError } from 'h3';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { HASH_RE } from '../utils/validate';

export default defineEventHandler((event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!HASH_RE.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const dir = join(SUBCAST_PATHS.cache, hash);
  for (const name of ['insights.json', 'insights.json.raw.txt']) {
    const p = join(dir, name);
    if (existsSync(p)) unlinkSync(p);
  }

  const db = getDb();
  db.prepare('DELETE FROM insight_tasks WHERE video_sha = ?').run(hash);

  return { ok: true };
});
