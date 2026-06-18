/* SPDX-License-Identifier: Apache-2.0 */

/**
 * PUT /api/diarize/[hash]/speakers/[speakerId] — Rename a speaker.
 *
 * Body: { displayName: string | null }
 *   `null` clears the display name and reverts to the i18n default
 *   (e.g. "说话人 A" / "Speaker A").
 *
 * UPSERT into the speakers table — diarize may not have registered a
 * row yet if this endpoint is called via some unusual flow, so we
 * tolerate that and create on demand.
 */

import { defineEventHandler, getRouterParam, readBody, createError } from 'h3';
import { getDb } from '../../../../utils/db';
import { isValidHash } from '../../../../utils/validate';

interface ReqBody {
  displayName: string | null;
}

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  const speakerId = getRouterParam(event, 'speakerId');
  if (!isValidHash(hash)) throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  if (!speakerId) throw createError({ statusCode: 400, statusMessage: 'BAD_SPEAKER_ID' });

  // Sanity check the speaker_id shape — must be 'speaker_X' or 'unknown'.
  if (speakerId !== 'unknown' && !/^speaker_[A-Z]{1,2}$/.test(speakerId)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_SPEAKER_ID_FORMAT' });
  }

  const body = await readBody<ReqBody>(event);
  const trimmed = typeof body?.displayName === 'string' ? body.displayName.trim() : null;
  const displayName: string | null = trimmed && trimmed.length > 0 ? trimmed : null;

  const db = getDb();

  const video = db
    .prepare('SELECT 1 FROM videos WHERE sha256 = ?')
    .get(hash) as { 1: number } | undefined;
  if (!video) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  // UPSERT pattern using INSERT OR REPLACE — speakers table primary
  // key (video_sha, speaker_id) means we get atomic replace.
  db.prepare(
    `INSERT INTO speakers (video_sha, speaker_id, display_name)
     VALUES (?, ?, ?)
     ON CONFLICT(video_sha, speaker_id)
     DO UPDATE SET display_name = excluded.display_name`,
  ).run(hash, speakerId, displayName);

  return { ok: true as const, speakerId, displayName };
});
