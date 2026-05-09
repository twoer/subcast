import { translateQueue } from '../../../utils/queue';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'MISSING_ID' });
  const ok = translateQueue.cancel(id);
  if (!ok) {
    throw createError({
      statusCode: 404,
      statusMessage: 'TASK_NOT_FOUND_OR_TERMINAL',
    });
  }
  return { ok: true, taskId: id };
});
