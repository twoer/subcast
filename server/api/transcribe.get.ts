/* SPDX-License-Identifier: Apache-2.0 */
// server/api/transcribe.get.ts
// Slice 3: delegate to the persistent queue. The queue handles task creation,
// history replay, live frame fan-out, restart recovery, and chunk-level resume.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatSse } from '../utils/sse';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { transcribeQueue } from '../utils/queue';
import { loadSettings } from '../utils/settings';
import { setupSseStream } from '../utils/sseStream';
import { isValidHash } from '../utils/validate';
import { isWhisperModelReady } from '../utils/whisperInstalled';
import { isSenseVoiceReady } from '../utils/sensevoice';
import type { VideoRow } from '../types/db';

export default defineEventHandler(async (event) => {
  const { hash } = getQuery(event);
  if (!isValidHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const row = db
    .prepare('SELECT sha256, ext FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'sha256' | 'ext'> | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  const videoPath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);
  if (!existsSync(videoPath)) {
    throw createError({ statusCode: 500, statusMessage: 'VIDEO_FILE_MISSING' });
  }

  // Settings may point at a model that isn't fully on disk (cancelled
  // download / fresh install). Refuse the job up front with a clear
  // error rather than failing mid-chunk inside the engine.
  // Engine dispatch point #3 (migrate into the engine registry when the
  // lite branch's abstraction lands). `auto` may dispatch to either
  // engine at runtime — pass when at least one is usable.
  const settings = loadSettings();
  const activeModel = settings.whisperModel;
  if (settings.transcribeEngine === 'sensevoice') {
    if (!isSenseVoiceReady()) {
      throw createError({
        statusCode: 409,
        statusMessage: 'SENSE_VOICE_NOT_INSTALLED',
      });
    }
  } else if (settings.transcribeEngine === 'auto') {
    const [svReady, whisperReady] = await Promise.all([
      Promise.resolve(isSenseVoiceReady()),
      isWhisperModelReady(activeModel),
    ]);
    if (!svReady && !whisperReady) {
      throw createError({
        statusCode: 409,
        statusMessage: 'WHISPER_MODEL_NOT_INSTALLED',
        data: { model: activeModel },
      });
    }
  } else if (!(await isWhisperModelReady(activeModel))) {
    throw createError({
      statusCode: 409,
      statusMessage: 'WHISPER_MODEL_NOT_INSTALLED',
      data: { model: activeModel },
    });
  }

  const task = transcribeQueue.ensureTask(row.sha256);
  await transcribeQueue.tryStartNext();

  const sse = setupSseStream(event);
  let frameId = 0;
  try {
    for await (const frame of transcribeQueue.attach(task.id)) {
      if (sse.isClosed()) break;
      if (!sse.write(formatSse({ ...frame, id: frameId++ }))) break;
    }
  } finally {
    sse.close();
  }
});
