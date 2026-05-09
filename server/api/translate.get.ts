// Slice 5: translation SSE endpoint. In-memory subscriber fan-out (no
// DB-backed queue yet — Slice 6 brings the full translateQueue per design §4).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { getDb, SUBCAST_PATHS } from '../utils/db';
import { logEvent } from '../utils/log';
import {
  DEFAULT_TRANSLATE_MODEL,
  isOllamaReady,
  translateAll,
} from '../utils/ollama';
import { formatSse } from '../utils/sse';
import { parseVtt, serializeVtt, type Cue } from '../utils/vtt';

const VALID_LANG = /^[a-z]{2}(-[A-Z]{2})?$/;

interface TranslationRun {
  emitter: EventEmitter;
  taskId: string;
  totalBatches: number;
  doneBatches: number;
  cues: Cue[];
  status: 'running' | 'completed' | 'failed';
  error?: { code: string; msg: string };
}

const activeRuns = new Map<string, TranslationRun>();
const runKey = (sha: string, lang: string) => `${sha}:${lang}`;

function getOriginalCues(videoSha: string): Cue[] {
  const vttPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');
  if (!existsSync(vttPath)) {
    throw createError({ statusCode: 409, statusMessage: 'ORIGINAL_NOT_READY' });
  }
  return parseVtt(readFileSync(vttPath, 'utf8'));
}

function startRun(
  videoSha: string,
  lang: string,
  taskId: string,
  model: string,
): TranslationRun {
  const db = getDb();
  const cues = getOriginalCues(videoSha);
  const totalBatches = Math.max(1, Math.ceil(cues.length / 40));

  const run: TranslationRun = {
    emitter: new EventEmitter(),
    taskId,
    totalBatches,
    doneBatches: 0,
    cues: [],
    status: 'running',
  };
  activeRuns.set(runKey(videoSha, lang), run);

  void (async () => {
    try {
      const out = await translateAll(cues, lang, {
        model,
        onSuperBatchStart: (info) => {
          run.emitter.emit('frame', {
            event: 'batch-progress',
            data: {
              taskId,
              doneBatches: info.batchIdx,
              totalBatches: info.totalBatches,
              progressPct: Math.round((info.batchIdx / info.totalBatches) * 100),
            },
          });
        },
        onSuperBatchDone: (info) => {
          run.doneBatches = info.batchIdx + 1;
          run.cues.push(...info.cues);
          run.emitter.emit('frame', {
            event: 'cue-translated',
            data: {
              taskId,
              batchIdx: info.batchIdx,
              cues: info.cues.map((c) => ({
                startMs: c.startMs,
                endMs: c.endMs,
                text: c.text,
              })),
            },
          });
          run.emitter.emit('frame', {
            event: 'batch-progress',
            data: {
              taskId,
              doneBatches: run.doneBatches,
              totalBatches: info.totalBatches,
              progressPct: Math.round((run.doneBatches / info.totalBatches) * 100),
            },
          });
          db.prepare(`UPDATE translate_tasks SET progress_pct = ? WHERE id = ?`).run(
            Math.round((run.doneBatches / info.totalBatches) * 100),
            taskId,
          );
        },
        onBatchRetry: (info) => {
          run.emitter.emit('frame', {
            event: 'batch-retry',
            data: { taskId, batchIdx: info.batchIdx, attempt: info.attempt, reason: info.reason },
          });
        },
      });

      const cacheDir = join(SUBCAST_PATHS.cache, videoSha);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, `${lang}.vtt`), serializeVtt(out), 'utf8');
      db.prepare(
        `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
         VALUES (?, ?, 'translated', ?, ?)
         ON CONFLICT(video_sha, lang) DO UPDATE SET
           cues_count = excluded.cues_count,
           completed_at = excluded.completed_at`,
      ).run(videoSha, lang, out.length, Date.now());
      db.prepare(
        `UPDATE translate_tasks SET status='completed', progress_pct=100, completed_at=? WHERE id=?`,
      ).run(Date.now(), taskId);

      run.status = 'completed';
      run.emitter.emit('frame', {
        event: 'done',
        data: { taskId, totalCues: out.length },
      });
      logEvent({ level: 'info', event: 'translate_completed', taskId, lang, cues: out.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.startsWith('BATCH_RETRY_EXHAUSTED')
        ? 'BATCH_RETRY_EXHAUSTED'
        : msg.includes('Ollama HTTP') || msg.includes('OLLAMA_UNREACHABLE')
          ? 'OLLAMA_UNREACHABLE'
          : 'FATAL_UNKNOWN';
      run.status = 'failed';
      run.error = { code, msg };
      db.prepare(`UPDATE translate_tasks SET status='failed', error_msg=? WHERE id=?`)
        .run(msg, taskId);
      run.emitter.emit('frame', { event: 'error', data: { taskId, code, msg } });
      logEvent({ level: 'error', event: 'translate_failed', taskId, lang, code, msg });
    } finally {
      run.emitter.emit('end');
      activeRuns.delete(runKey(videoSha, lang));
    }
  })();

  return run;
}

/**
 * Resolve to a function that asynchronously yields SSE frames for the given
 * (hash, lang). Pre-flight (validation, cache hit, ollama check, task row,
 * run-bootstrap) happens before the iterable starts; the iterable yields a
 * status frame, then either a cache replay + done, an error, or the live tail
 * from the run's emitter.
 */
async function buildFrameIterable(
  hash: string,
  lang: string,
): Promise<AsyncIterable<{ event: string; data: Record<string, unknown> }>> {
  const db = getDb();
  let task = db
    .prepare(
      `SELECT id, status, model FROM translate_tasks WHERE video_sha = ? AND target_lang = ?`,
    )
    .get(hash, lang) as { id: string; status: string; model: string } | undefined;
  const cachedRow = db
    .prepare(`SELECT cues_count FROM subtitles WHERE video_sha = ? AND lang = ?`)
    .get(hash, lang) as { cues_count: number } | undefined;
  const vttPath = join(SUBCAST_PATHS.cache, hash, `${lang}.vtt`);
  // Cache hit only requires the on-disk artifacts; the task row is bookkeeping
  // and may be GC'd or pruned later without invalidating the cache.
  const fromCache = !!cachedRow && existsSync(vttPath);

  if (fromCache) {
    const taskId = task?.id ?? 'cache';
    const cues = parseVtt(await readFile(vttPath, 'utf8'));
    return (async function* () {
      yield { event: 'status', data: { taskId, status: 'running', model: task?.model ?? DEFAULT_TRANSLATE_MODEL, fromCache: true, lang } };
      yield {
        event: 'cue-translated',
        data: {
          taskId,
          batchIdx: 0,
          cues: cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
        },
      };
      yield { event: 'done', data: { taskId, totalCues: cues.length, fromCache: true } };
    })();
  }

  const ready = await isOllamaReady();
  if (!ready.ok) {
    return (async function* () {
      yield {
        event: 'error',
        data: {
          taskId: task?.id ?? 'pending',
          code: ready.reason.startsWith('MODEL_NOT_PULLED') ? 'MODEL_NOT_PULLED' : 'OLLAMA_UNREACHABLE',
          msg: ready.reason,
        },
      };
    })();
  }

  if (!task) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO translate_tasks (id, video_sha, target_lang, status, model, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    ).run(id, hash, lang, DEFAULT_TRANSLATE_MODEL, Date.now());
    task = { id, status: 'queued', model: DEFAULT_TRANSLATE_MODEL };
  } else if (task.status === 'failed') {
    db.prepare(`UPDATE translate_tasks SET status='queued', error_msg=NULL WHERE id=?`).run(task.id);
    task.status = 'queued';
  }

  const key = runKey(hash, lang);
  let run = activeRuns.get(key);
  if (!run) {
    db.prepare(`UPDATE translate_tasks SET status='running' WHERE id=?`).run(task.id);
    run = startRun(hash, lang, task.id, task.model);
  }
  const liveRun = run;

  return (async function* () {
    yield {
      event: 'status',
      data: { taskId: liveRun.taskId, status: 'running', model: task!.model, fromCache: false, lang },
    };
    if (liveRun.cues.length > 0) {
      yield {
        event: 'cue-translated',
        data: {
          taskId: liveRun.taskId,
          batchIdx: -1,
          cues: liveRun.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
        },
      };
    }
    if (liveRun.status === 'completed') {
      yield { event: 'done', data: { taskId: liveRun.taskId, totalCues: liveRun.cues.length } };
      return;
    }
    if (liveRun.status === 'failed' && liveRun.error) {
      yield { event: 'error', data: { taskId: liveRun.taskId, code: liveRun.error.code, msg: liveRun.error.msg } };
      return;
    }

    const buffer: Array<{ event: string; data: Record<string, unknown> }> = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    const onFrame = (f: { event: string; data: Record<string, unknown> }) => {
      buffer.push(f);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };
    const onEnd = () => {
      finished = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };
    liveRun.emitter.on('frame', onFrame);
    liveRun.emitter.once('end', onEnd);

    try {
      while (true) {
        while (buffer.length > 0) yield buffer.shift()!;
        if (finished) break;
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      liveRun.emitter.off('frame', onFrame);
      liveRun.emitter.off('end', onEnd);
    }
  })();
}

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

  // Same single-loop pattern as transcribe.get.ts: drive a stream.write loop
  // over an AsyncIterable and never `return` early. This avoids Nitro
  // collapsing the response body when the handler exits before any flush.
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
    const iterable = await buildFrameIterable(hash, lang);
    for await (const frame of iterable) {
      if (closed) break;
      stream.write(formatSse({ ...frame, id: frameId++ }));
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) stream.end();
  }
});
