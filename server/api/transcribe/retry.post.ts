/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/transcribe/retry
 *
 * Body: { hash: string, model?: string }
 *
 * Re-transcribe an existing video from scratch. Cascades a clean-slate
 * reset because the new transcript invalidates everything derived from
 * it:
 *   - original + translated subtitles
 *   - cached .vtt files (original.vtt, <lang>.vtt)
 *   - insights.json + insights.json.raw.txt
 *   - transcribe_tasks + translate_tasks + insight_tasks rows
 *
 * Keeps:
 *   - the video binary itself (so we don't force a re-upload)
 *   - the `videos` row (display name, original name, last-opened, etc.)
 *
 * Then enqueues a fresh transcribe task using the requested whisper
 * model (or the current setting) and returns its summary.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createError, defineEventHandler, readBody } from 'h3';
import { isWhisperModelName } from '#shared/whisperModels';
import { getDb, SUBCAST_PATHS } from '../../utils/db';
import { logEvent } from '../../utils/log';
import { deleteVideoGraph } from '../../utils/mediaGraphDelete';
import { transcribeQueue, llmQueue } from '../../utils/queue';
import { loadSettings } from '../../utils/settings';
import { isValidHash } from '../../utils/validate';
import { isWhisperModelReady } from '../../utils/whisperInstalled';
import type { VideoRow } from '../../types/db';

interface RetryBody {
  hash?: string;
  model?: string;
}

export default defineEventHandler(async (event) => {
  const body = await readBody<RetryBody>(event);
  const hash = body?.hash;
  if (!isValidHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const model = body?.model ?? loadSettings().whisperModel;
  if (!isWhisperModelName(model)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_MODEL' });
  }
  // Refuse the retry up front when the target model isn't actually on
  // disk — otherwise we'd wipe the user's subtitles + translations to
  // re-run a job that whisper-cli can't load.
  if (!(await isWhisperModelReady(model))) {
    throw createError({
      statusCode: 409,
      statusMessage: 'WHISPER_MODEL_NOT_INSTALLED',
      data: { model },
    });
  }

  const db = getDb();
  const row = db
    .prepare(`SELECT sha256 FROM videos WHERE sha256 = ?`)
    .get(hash) as Pick<VideoRow, 'sha256'> | undefined;
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });
  }

  // Cancel any in-flight insight tasks before wiping the output dir.
  const runningInsights = db
    .prepare(
      `SELECT id FROM insight_tasks
       WHERE video_sha = ? AND status IN ('queued','running')`,
    )
    .all(hash) as { id: string }[];
  for (const row of runningInsights) {
    llmQueue.cancel(row.id);
  }

  // Cancel any active transcribe/translate tasks for this video. The
  // queue's `cancelTask` clears the active worker if it owns the task.
  const activeTasks = db
    .prepare(
      `SELECT id FROM transcribe_tasks WHERE video_sha = ? AND status IN ('queued','running')`,
    )
    .all(hash) as Array<{ id: string }>;
  for (const t of activeTasks) transcribeQueue.cancel(t.id);

  // Wipe the cache directory (vtt files, chunked audio, insights). The
  // video binary lives in SUBCAST_PATHS.videos and is untouched.
  const cacheDir = join(SUBCAST_PATHS.cache, hash);
  if (existsSync(cacheDir)) {
    await rm(cacheDir, { recursive: true, force: true });
  }

  // Cascade-delete derived DB rows in one transaction. Note we keep the
  // `videos` row so display_name and metadata persist.
  // PRAGMA foreign_keys is a no-op inside a transaction; toggle before it.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      deleteVideoGraph(db, hash, { keepVideo: true });
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  logEvent({ level: 'info', event: 'transcribe_retry', sha: hash, model });

  const task = transcribeQueue.ensureTask(hash, model);
  void transcribeQueue.tryStartNext();
  return { ok: true, task };
});
