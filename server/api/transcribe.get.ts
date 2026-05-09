// server/api/transcribe.get.ts
// Nitro auto-imports getDb / SUBCAST_PATHS / transcribeOnce / formatSse /
// parseVtt / serializeVtt.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Cue } from '~~/server/utils/vtt';

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

  const cacheDir = join(SUBCAST_PATHS.cache, row.sha256);
  const vttPath = join(cacheDir, 'original.vtt');
  const metaPath = join(cacheDir, 'meta.json');

  const cachedRow = db
    .prepare(
      "SELECT cues_count FROM subtitles WHERE video_sha = ? AND lang = 'original'",
    )
    .get(hash) as { cues_count: number } | undefined;
  const fromCache = !!cachedRow && existsSync(vttPath);

  if (!fromCache && isTranscribing) {
    throw createError({ statusCode: 409, statusMessage: 'ALREADY_RUNNING' });
  }
  if (!fromCache) isTranscribing = true;

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
    const heartbeat = setInterval(() => stream.write(': heartbeat\n\n'), 15_000);

    (async () => {
      try {
        if (fromCache) {
          send({
            event: 'status',
            data: { taskId, requestId, status: 'running', model: 'base', fromCache: true },
          });
          const vtt = await readFile(vttPath, 'utf8');
          const cues = parseVtt(vtt);
          let chunkIdx = 0;
          for (const cue of cues) {
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
          send({ event: 'done', data: { taskId, requestId, totalCues: chunkIdx, fromCache: true } });
          return;
        }

        send({
          event: 'status',
          data: { taskId, requestId, status: 'running', model: 'base', fromCache: false },
        });
        const collected: Cue[] = [];
        let chunkIdx = 0;
        for await (const cue of transcribeOnce(videoPath)) {
          collected.push(cue);
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

        await mkdir(cacheDir, { recursive: true });
        await writeFile(vttPath, serializeVtt(collected), 'utf8');
        await writeFile(
          metaPath,
          JSON.stringify(
            {
              sha256: row.sha256,
              originalName: undefined,
              ext: row.ext,
              transcribedAt: Date.now(),
              cuesCount: collected.length,
              model: 'base',
            },
            null,
            2,
          ),
          'utf8',
        );
        db.prepare(
          `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
           VALUES (?, 'original', 'transcribed', ?, ?)
           ON CONFLICT(video_sha, lang) DO UPDATE SET
             cues_count = excluded.cues_count,
             completed_at = excluded.completed_at`,
        ).run(row.sha256, collected.length, Date.now());

        send({ event: 'done', data: { taskId, requestId, totalCues: chunkIdx } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({
          event: 'error',
          data: { taskId, requestId, code: 'FATAL_UNKNOWN', msg },
        });
      } finally {
        clearInterval(heartbeat);
        if (!fromCache) isTranscribing = false;
        stream.end();
        resolve();
      }
    })().catch(reject);

    event.node.req.on('close', () => {
      clearInterval(heartbeat);
      if (!fromCache) isTranscribing = false;
    });
  });
});
