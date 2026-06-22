/* SPDX-License-Identifier: Apache-2.0 */
// DELETE /api/import-url?jobId=<uuid>  -> { ok, canceled }
//
// Cancels a URL import job. If the task is still queued it is dropped before
// yt-dlp ever runs; if yt-dlp is mid-download the ChildProcess is SIGTERM'd
// and the queue's exit handler treats the non-zero exit as a cancellation
// (task.phase === 'canceled'), cleaning up the partial download. Returns
// `canceled: false` for unknown or already-terminal job ids so the client
// can treat the response idempotently.
import { defineEventHandler, getQuery, createError } from 'h3';
import { logEvent } from '../utils/log';
import { urlImportQueue } from '../utils/urlImportQueue';

export default defineEventHandler((event) => {
  const { jobId } = getQuery(event);
  if (typeof jobId !== 'string' || !jobId) {
    throw createError({ statusCode: 400, statusMessage: 'jobId required' });
  }

  try {
    const canceled = urlImportQueue.cancel(jobId);
    return { ok: true, canceled };
  } catch (err: unknown) {
    // cancel() is synchronous and doesn't throw today, but defend against
    // future internal errors so a diagnostics zip captures the stack
    // instead of an unhandled rejection.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logEvent({ level: 'error', event: 'import_url_cancel_failed', message, stack });
    throw createError({ statusCode: 500, statusMessage: 'cancel failed' });
  }
});
