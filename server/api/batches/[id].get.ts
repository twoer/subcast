/* SPDX-License-Identifier: Apache-2.0 */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { getBatchJob } from '../../utils/batchRepo';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_BATCH_ID' });
  const job = getBatchJob(id);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'BATCH_NOT_FOUND' });
  return { job };
});
