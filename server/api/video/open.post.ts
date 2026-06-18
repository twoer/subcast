/* SPDX-License-Identifier: Apache-2.0 */
// Stamp `last_opened_at` with the current time so the library's
// "most recently viewed first" ordering reflects actual viewing
// instead of just upload time. Called by the player page on mount.
// Best-effort from the client side — failures don't block playback.
import { getDb } from '../../utils/db';
import { isValidHash } from '../../utils/validate';

export default defineEventHandler(async (event) => {
  const { hash } = getQuery(event);
  if (!isValidHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }
  const db = getDb();
  const now = Date.now();
  const info = db
    .prepare('UPDATE videos SET last_opened_at = ? WHERE sha256 = ?')
    .run(now, hash);
  if (info.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });
  }
  return { ok: true, lastOpenedAt: now };
});
