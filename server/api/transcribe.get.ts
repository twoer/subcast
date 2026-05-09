// server/api/transcribe.get.ts
// Slice 3: delegate to the persistent queue. The queue handles task creation,
// history replay, live frame fan-out, restart recovery, and chunk-level resume.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatSse } from '../utils/sse';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { transcribeQueue } from '../utils/queue';

export default defineEventHandler(async (event) => {
  const { hash } = getQuery(event);
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const row = db
    .prepare('SELECT sha256, ext FROM videos WHERE sha256 = ?')
    .get(hash) as { sha256: string; ext: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  const videoPath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);
  if (!existsSync(videoPath)) {
    throw createError({ statusCode: 500, statusMessage: 'VIDEO_FILE_MISSING' });
  }

  const task = transcribeQueue.ensureTask(row.sha256);
  await transcribeQueue.tryStartNext();

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
    for await (const frame of transcribeQueue.attach(task.id)) {
      if (closed) break;
      stream.write(formatSse({ ...frame, id: frameId++ }));
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) stream.end();
  }
});
