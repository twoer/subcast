// server/api/transcribe.get.ts
// Nitro auto-imports getDb / SUBCAST_PATHS / transcribeOnce / formatSse.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

let isTranscribing = false;

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

  if (isTranscribing) {
    throw createError({ statusCode: 409, statusMessage: 'ALREADY_RUNNING' });
  }
  isTranscribing = true;

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const taskId = randomUUID();
  const requestId = randomUUID();
  const videoPath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);

  if (!existsSync(videoPath)) {
    isTranscribing = false;
    throw createError({ statusCode: 500, statusMessage: 'VIDEO_FILE_MISSING' });
  }

  return new Promise<void>((resolve, reject) => {
    const stream = event.node.res;

    let frameId = 0;
    const send = (frame: { event: string; data: Record<string, unknown> }) => {
      stream.write(formatSse({ ...frame, id: frameId++ }));
    };

    const heartbeat = setInterval(() => {
      stream.write(': heartbeat\n\n');
    }, 15_000);

    (async () => {
      try {
        send({
          event: 'status',
          data: { taskId, requestId, status: 'running', model: 'base' },
        });
        let chunkIdx = 0;
        for await (const cue of transcribeOnce(videoPath)) {
          send({
            event: 'cue',
            data: {
              taskId,
              requestId,
              chunkIdx: chunkIdx++,
              startMs: cue.startMs,
              endMs: cue.endMs,
              text: cue.text,
            },
          });
        }
        send({ event: 'done', data: { taskId, requestId, totalCues: chunkIdx } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({
          event: 'error',
          data: { taskId, requestId, code: 'FATAL_UNKNOWN', msg },
        });
      } finally {
        clearInterval(heartbeat);
        isTranscribing = false;
        stream.end();
        resolve();
      }
    })().catch(reject);

    event.node.req.on('close', () => {
      clearInterval(heartbeat);
      isTranscribing = false;
    });
  });
});
