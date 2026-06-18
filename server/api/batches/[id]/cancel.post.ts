/* SPDX-License-Identifier: Apache-2.0 */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { cancelBatch, getBatchJob } from '../../../utils/batchRepo';
import { cancelBatchChildren } from '../../../utils/batchRunner';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_BATCH_ID' });
  if (!getBatchJob(id)) throw createError({ statusCode: 404, statusMessage: 'BATCH_NOT_FOUND' });
  cancelBatchChildren(id);
  cancelBatch(id);
  return { ok: true as const };
});
