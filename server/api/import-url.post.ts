/* SPDX-License-Identifier: Apache-2.0 */
// POST /api/import-url  { url } -> { jobId }
import { urlImportQueue } from '../utils/urlImportQueue';
import { logEvent } from '../utils/log';

export default defineEventHandler(async (event) => {
  try {
    const body = await readBody<{ url?: unknown }>(event);
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) {
      throw createError({ statusCode: 400, statusMessage: 'url required' });
    }
    // Reject non-http(s) schemes up front to keep yt-dlp from being pointed
    // at file://, javascript:, etc. yt-dlp does its own URL validation too,
    // but this is a cheap first line of defense.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw createError({ statusCode: 400, statusMessage: 'invalid url' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw createError({ statusCode: 400, statusMessage: 'only http(s) urls are supported' });
    }

    const task = urlImportQueue.ensureTask(url);
    return { jobId: task.id };
  } catch (err: unknown) {
    // createError() throws an H3Error with a statusCode — those are
    // intentional 4xx and should pass through unchanged. Anything else
    // is an unexpected failure (DB, queue init, etc.); log the real
    // stack so it shows up in the app's diagnostics zip, then rethrow
    // as a generic 500 (the default) so the client just sees
    // "internal error" without leaking internals.
    const isH3Error =
      typeof err === 'object' && err !== null && 'statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number';
    if (!isH3Error) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logEvent({
        level: 'error',
        event: 'import_url_handler_failed',
        message,
        stack,
      });
    }
    throw err;
  }
});
