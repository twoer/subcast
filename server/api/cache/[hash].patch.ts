import { getDb } from '../../utils/db';

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const body = await readBody(event) as { displayName?: string | null };
  if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'INVALID_DISPLAY_NAME' });
  }

  const db = getDb();
  const displayName = (typeof body.displayName === 'string' ? body.displayName.trim() : null) || null;

  const result = db
    .prepare(`UPDATE videos SET display_name = ? WHERE sha256 = ?`)
    .run(displayName, hash);

  if (result.changes === 0) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  return { ok: true, sha256: hash, displayName };
});
