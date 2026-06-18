/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readBody } from 'h3';
import { createBatchJob } from '../../utils/batchRepo';
import { parseBatchOptions, isBatchPreset, parseVideoShas } from '../../utils/batchValidation';
import { getDb } from '../../utils/db';
import { logEvent } from '../../utils/log';
import { startBatch } from '../../utils/batchRunner';
import { planBatchWork } from '../../utils/batchReadiness';

interface ReqBody {
  name?: unknown;
  preset?: unknown;
  videoShas?: unknown;
  options?: unknown;
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? {};
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, 120)
    : 'Batch';
  if (!isBatchPreset(body.preset)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_PRESET' });
  }
  const videoShas = parseVideoShas(body.videoShas);
  if (!videoShas) throw createError({ statusCode: 400, statusMessage: 'BAD_VIDEO_SHAS' });
  const options = parseBatchOptions(body.options);
  if (!options) throw createError({ statusCode: 400, statusMessage: 'BAD_OPTIONS' });

  const db = getDb();
  const placeholders = videoShas.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT sha256 FROM videos WHERE sha256 IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...videoShas) as Array<{ sha256: string }>;
  if (rows.length !== videoShas.length) {
    throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });
  }

  const work = planBatchWork(videoShas, options);
  if (work.items.length === 0) {
    return {
      id: null,
      skipped: true,
      totalVideos: work.totalVideos,
      readyVideos: work.readyVideos,
    };
  }

  const { id } = createBatchJob({
    name,
    preset: body.preset,
    options,
    videoShas: work.items.map((item) => item.videoSha),
  });

  void startBatch(id).catch((err: unknown) => {
    logEvent({
      level: 'error',
      event: 'batch_start_failed',
      batchId: id,
      msg: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  return {
    id,
    skipped: false,
    totalVideos: work.totalVideos,
    readyVideos: work.readyVideos,
    queuedVideos: work.items.length,
  };
});
