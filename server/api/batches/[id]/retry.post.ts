/* SPDX-License-Identifier: Apache-2.0 */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { getBatchJob, retryFailedBatchItems } from '../../../utils/batchRepo';
import { startBatch } from '../../../utils/batchRunner';
import { logEvent } from '../../../utils/log';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_BATCH_ID' });
  if (!getBatchJob(id)) throw createError({ statusCode: 404, statusMessage: 'BATCH_NOT_FOUND' });
  retryFailedBatchItems(id);
  void startBatch(id).catch((err: unknown) => {
    logEvent({
      level: 'error',
      event: 'batch_retry_start_failed',
      batchId: id,
      msg: err instanceof Error ? err.message : String(err),
    });
  });
  return { ok: true as const };
});
