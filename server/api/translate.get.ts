// Slice 6: thin SSE shim over translateQueue. The queue holds the worker,
// emitter fan-out, priority ordering, restart recovery and cancellation.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getDb, SUBCAST_PATHS } from '../utils/db';
import { translateQueue } from '../utils/queue';
import { formatSse } from '../utils/sse';

const VALID_LANG = /^[a-z]{2}(-[A-Z]{2})?$/;

export default defineEventHandler(async (event) => {
  const { hash, lang } = getQuery(event);
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }
  if (typeof lang !== 'string' || !VALID_LANG.test(lang)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_LANG' });
  }

  const db = getDb();
  const video = db
    .prepare('SELECT sha256 FROM videos WHERE sha256 = ?')
    .get(hash) as { sha256: string } | undefined;
  if (!video) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  // Require original transcription before allowing translate.
  const origPath = join(SUBCAST_PATHS.cache, hash, 'original.vtt');
  if (!existsSync(origPath)) {
    throw createError({ statusCode: 409, statusMessage: 'ORIGINAL_NOT_READY' });
  }

  const task = translateQueue.ensureTask(hash, lang);
  // Spec §3: every GET /api/translate is treated as user-initiated; bump the
  // priority so this lang takes the next slot ahead of any background-queued
  // langs. Currently running task is NOT preempted.
  if (task.status === 'queued') {
    translateQueue.bumpPriority(task.id);
  }
  await translateQueue.tryStartNext();

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const stream = event.node.res;
  let frameId = 0;
  const heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), 15_000);
  let closed = false;
  event.node.req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  try {
    for await (const frame of translateQueue.attach(task.id)) {
      if (closed) break;
      stream.write(formatSse({ ...frame, id: frameId++ }));
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) stream.end();
  }
});
