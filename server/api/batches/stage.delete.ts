/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readBody } from 'h3';
import { cleanupBatchStages } from '../../utils/batchStage';

interface ReqBody {
  stageIds?: unknown;
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? {};
  if (!Array.isArray(body.stageIds)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_STAGE_IDS' });
  }
  const stageIds = body.stageIds.filter((id): id is string => typeof id === 'string');
  await cleanupBatchStages(stageIds);
  return { ok: true };
});
