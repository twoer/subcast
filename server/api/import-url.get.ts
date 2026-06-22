/* SPDX-License-Identifier: Apache-2.0 */
// GET /api/import-url?jobId=<uuid>  -> text/event-stream of progress frames
// Mirrors the transcribe.get.ts SSE pattern: attach to the queue's async
// iterator and forward each frame as an SSE event.
import { formatSse } from '../utils/sse';
import { setupSseStream } from '../utils/sseStream';
import { urlImportQueue } from '../utils/urlImportQueue';

export default defineEventHandler(async (event) => {
  const { jobId } = getQuery(event);
  if (typeof jobId !== 'string' || !jobId) {
    throw createError({ statusCode: 400, statusMessage: 'jobId required' });
  }
  // jobId is a UUID; the queue.getTask call below handles unknown ids.

  const task = urlImportQueue.getTask(jobId);
  if (!task) {
    throw createError({ statusCode: 404, statusMessage: 'JOB_NOT_FOUND' });
  }

  const sse = setupSseStream(event);
  let frameId = 0;
  try {
    for await (const frame of urlImportQueue.attach(jobId)) {
      if (sse.isClosed()) break;
      if (!sse.write(formatSse({ event: 'progress', data: { ...frame, id: frameId++ } }))) break;
    }
  } finally {
    sse.close();
  }
});
