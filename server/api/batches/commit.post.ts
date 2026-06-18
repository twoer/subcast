/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readBody } from 'h3';
import { BATCH_STAGE_ID_RE, commitBatchStage } from '../../utils/batchStage';

interface ReqBody {
  stageIds?: unknown;
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? {};
  if (!Array.isArray(body.stageIds)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_STAGE_IDS' });
  }
  const stageIds = body.stageIds.filter((id): id is string =>
    typeof id === 'string' && BATCH_STAGE_ID_RE.test(id),
  );
  const metas = [];
  for (const stageId of stageIds) {
    metas.push(await commitBatchStage(stageId));
  }
  return {
    items: metas.map((meta) => ({
      hash: meta.sha256,
      originalName: meta.originalName,
      ext: meta.ext,
      sizeBytes: meta.sizeBytes,
    })),
  };
});
