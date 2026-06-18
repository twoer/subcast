/* SPDX-License-Identifier: Apache-2.0 */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { llmQueue } from '../../../utils/queue';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'MISSING_ID' });
  const ok = llmQueue.cancel(id);
  if (!ok) {
    throw createError({
      statusCode: 404,
      statusMessage: 'TASK_NOT_FOUND_OR_TERMINAL',
    });
  }
  return { ok: true, taskId: id };
});
