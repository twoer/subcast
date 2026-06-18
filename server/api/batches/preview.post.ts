/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readBody } from 'h3';
import { parseBatchOptions, parseVideoShas } from '../../utils/batchValidation';
import { getDb } from '../../utils/db';
import { planBatchWork } from '../../utils/batchReadiness';

interface ReqBody {
  videoShas?: unknown;
  options?: unknown;
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? {};
  const videoShas = parseVideoShas(body.videoShas);
  if (!videoShas) throw createError({ statusCode: 400, statusMessage: 'BAD_VIDEO_SHAS' });
  const options = parseBatchOptions(body.options);
  if (!options) throw createError({ statusCode: 400, statusMessage: 'BAD_OPTIONS' });

  const placeholders = videoShas.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT sha256 FROM videos WHERE sha256 IN (${placeholders}) AND deleted_at IS NULL`)
    .all(...videoShas) as Array<{ sha256: string }>;

  const existingShas = new Set(rows.map((row) => row.sha256));
  const existingWork = planBatchWork(rows.map((row) => row.sha256), options);
  const newVideoCount = videoShas.filter((sha) => !existingShas.has(sha)).length;
  const queuedVideos = existingWork.items.length + newVideoCount;
  return {
    totalVideos: videoShas.length,
    readyVideos: existingWork.readyVideos,
    queuedVideos,
    allReady: queuedVideos === 0,
  };
});
