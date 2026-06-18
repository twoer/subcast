/* SPDX-License-Identifier: Apache-2.0 */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { llmQueue } from '../../utils/queue';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_ID' });
  const aborted = llmQueue.cancel(id);
  return { ok: true, aborted };
});
