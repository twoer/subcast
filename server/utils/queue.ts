import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { detectHallucination, type HallucinationReason } from './quality';
import { extractWav, probeDurationS, transcribeChunk } from './whisper';
import { serializeVtt, type Cue } from './vtt';

export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

export interface TranscribeTaskRow {
  id: string;
  video_sha: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  model: string;
  total_chunks: number | null;
  done_chunks: number;
  error_msg: string | null;
}

const CHUNK_SEC = 30;

/**
 * F2 hallucination retry parameter ladder per design §5 A.
 * Attempt 1 is the canonical greedy pass; 2-3 escalate temperature and
 * disable previous-text conditioning to break out of repetition loops.
 */
const RETRY_PARAMS: ReadonlyArray<{ temperature: number; noContext: boolean }> = [
  { temperature: 0.0, noContext: false },
  { temperature: 0.4, noContext: true },
  { temperature: 0.8, noContext: true },
];

interface ActiveTask {
  taskId: string;
  emitter: EventEmitter;
  abort: AbortController;
}

class TranscribeQueue {
  private active: ActiveTask | null = null;

  ensureTask(videoSha: string, model = 'base'): TranscribeTaskRow {
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, video_sha, status, model, total_chunks, done_chunks, error_msg
         FROM transcribe_tasks
         WHERE video_sha = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(videoSha) as TranscribeTaskRow | undefined;
    if (existing) return existing;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    ).run(id, videoSha, model, Date.now());
    return {
      id,
      video_sha: videoSha,
      status: 'queued',
      model,
      total_chunks: null,
      done_chunks: 0,
      error_msg: null,
    };
  }

  async tryStartNext(): Promise<void> {
    if (this.active) return;
    const db = getDb();
    const next = db
      .prepare(
        `SELECT id, video_sha, model
         FROM transcribe_tasks
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as { id: string; video_sha: string; model: string } | undefined;
    if (!next) return;
    db.prepare(`UPDATE transcribe_tasks SET status='running' WHERE id = ?`).run(
      next.id,
    );
    this.active = {
      taskId: next.id,
      emitter: new EventEmitter(),
      abort: new AbortController(),
    };
    this.runWorker(next.id, next.video_sha, next.model).catch((err) => {
      console.error('[queue] worker crashed:', err);
    });
  }

  private async runWorker(taskId: string, videoSha: string, model: string): Promise<void> {
    const active = this.active;
    if (!active || active.taskId !== taskId) return;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
    const aborted = () => active.abort.signal.aborted;

    try {
      const videoRow = db
        .prepare(`SELECT ext FROM videos WHERE sha256 = ?`)
        .get(videoSha) as { ext: string } | undefined;
      if (!videoRow) throw new Error(`video row missing for ${videoSha}`);

      const videoPath = join(SUBCAST_PATHS.videos, `${videoSha}${videoRow.ext}`);
      await mkdir(SUBCAST_PATHS.tmp, { recursive: true });
      const wavPath = join(SUBCAST_PATHS.tmp, `${videoSha}.wav`);
      if (!existsSync(wavPath)) {
        await extractWav(videoPath, wavPath);
      }

      const durationS = await probeDurationS(wavPath);
      const totalChunks = Math.max(1, Math.ceil(durationS / CHUNK_SEC));
      db.prepare(`UPDATE transcribe_tasks SET total_chunks = ? WHERE id = ?`).run(
        totalChunks,
        taskId,
      );

      const persistedChunks = db
        .prepare(
          `SELECT chunk_idx FROM chunks WHERE task_id = ? ORDER BY chunk_idx ASC`,
        )
        .all(taskId) as { chunk_idx: number }[];
      const startIdx = persistedChunks.length === 0
        ? 0
        : Math.max(...persistedChunks.map((c) => c.chunk_idx)) + 1;

      emit({
        event: 'status',
        data: {
          taskId,
          status: startIdx > 0 ? 'resumed' : 'running',
          model,
          totalChunks,
          doneChunks: startIdx,
          fromCache: false,
        },
      });

      for (let chunkIdx = startIdx; chunkIdx < totalChunks; chunkIdx++) {
        if (aborted()) {
          db.prepare(`UPDATE transcribe_tasks SET status='canceled' WHERE id = ?`)
            .run(taskId);
          emit({ event: 'status', data: { taskId, status: 'canceled' } });
          return;
        }

        const startMs = chunkIdx * CHUNK_SEC * 1000;
        const endMs = Math.round(
          Math.min((chunkIdx + 1) * CHUNK_SEC, durationS) * 1000,
        );
        const chunkDurationMs = endMs - startMs;

        // F2 retry ladder: try up to 3 param combinations; accept the first
        // that passes hallucination detection. If all fail, keep attempt-1's
        // cues and mark the chunk 'suspect'.
        let firstCues: Cue[] | null = null;
        let acceptedCues: Cue[] | null = null;
        let quality: 'ok' | 'suspect' = 'ok';
        let retryCount = 0;
        let lastReason: HallucinationReason | null = null;

        for (let attempt = 0; attempt < RETRY_PARAMS.length; attempt++) {
          if (aborted()) break;
          const params = RETRY_PARAMS[attempt]!;
          const cues = await transcribeChunk(wavPath, chunkIdx, CHUNK_SEC, durationS, {
            model: model as Parameters<typeof transcribeChunk>[4]['model'],
            temperature: params.temperature,
            noContext: params.noContext,
          });
          if (firstCues === null) firstCues = cues;
          const reason = detectHallucination(cues, chunkDurationMs);
          if (!reason) {
            acceptedCues = cues;
            retryCount = attempt;
            break;
          }
          lastReason = reason;
          logEvent({
            level: 'warn',
            event: 'chunk_hallucination',
            taskId,
            chunkIdx,
            attempt: attempt + 1,
            reason,
          });
          if (attempt < RETRY_PARAMS.length - 1) {
            emit({
              event: 'chunk-retry',
              data: { taskId, chunkIdx, attempt: attempt + 1, reason },
            });
          }
        }

        if (acceptedCues === null) {
          // all 3 attempts failed → keep first attempt's cues, mark suspect
          acceptedCues = firstCues!;
          quality = 'suspect';
          retryCount = RETRY_PARAMS.length - 1;
          logEvent({
            level: 'error',
            event: 'chunk_suspect_persisted',
            taskId,
            chunkIdx,
            reason: lastReason,
          });
        }

        db.prepare(
          `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json, quality, retry_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, chunk_idx) DO UPDATE SET
             cues_json = excluded.cues_json,
             quality = excluded.quality,
             retry_count = excluded.retry_count`,
        ).run(
          taskId,
          chunkIdx,
          startMs,
          endMs,
          JSON.stringify(acceptedCues),
          quality,
          retryCount,
        );
        db.prepare(`UPDATE transcribe_tasks SET done_chunks = ? WHERE id = ?`).run(
          chunkIdx + 1,
          taskId,
        );
        for (const cue of acceptedCues) {
          emit({
            event: 'cue',
            data: {
              taskId,
              chunkIdx,
              startMs: cue.startMs,
              endMs: cue.endMs,
              text: cue.text,
              quality,
            },
          });
        }
        emit({
          event: 'chunk-complete',
          data: { taskId, chunkIdx, doneChunks: chunkIdx + 1, totalChunks, quality },
        });
      }

      const allChunkRows = db
        .prepare(
          `SELECT cues_json FROM chunks WHERE task_id = ? ORDER BY chunk_idx ASC`,
        )
        .all(taskId) as { cues_json: string }[];
      const allCues: Cue[] = allChunkRows.flatMap(
        (r) => JSON.parse(r.cues_json) as Cue[],
      );

      const cacheDir = join(SUBCAST_PATHS.cache, videoSha);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, 'original.vtt'), serializeVtt(allCues), 'utf8');
      await writeFile(
        join(cacheDir, 'meta.json'),
        JSON.stringify(
          {
            sha256: videoSha,
            ext: videoRow.ext,
            transcribedAt: Date.now(),
            cuesCount: allCues.length,
            model,
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
      ).run(videoSha, allCues.length, Date.now());
      db.prepare(
        `UPDATE transcribe_tasks SET status='completed', completed_at = ? WHERE id = ?`,
      ).run(Date.now(), taskId);
      await unlink(wavPath).catch(() => {});

      emit({
        event: 'done',
        data: { taskId, totalCues: allCues.length },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE transcribe_tasks SET status='failed', error_msg = ? WHERE id = ?`,
      ).run(msg, taskId);
      emit({
        event: 'error',
        data: { taskId, code: 'FATAL_UNKNOWN', msg },
      });
    } finally {
      active.emitter.emit('end');
      this.active = null;
      this.tryStartNext().catch((err) => {
        console.error('[queue] tryStartNext failed:', err);
      });
    }
  }

  /**
   * Subscribe to a task: replay history from chunks table, then live frames if
   * task is still running. Multiple subscribers can attach concurrently.
   */
  async *attach(taskId: string): AsyncIterable<SseFrame> {
    const db = getDb();
    const task = db
      .prepare(
        `SELECT id, video_sha, status, model, total_chunks, done_chunks, error_msg
         FROM transcribe_tasks WHERE id = ?`,
      )
      .get(taskId) as TranscribeTaskRow | undefined;
    if (!task) {
      yield {
        event: 'error',
        data: { taskId, code: 'TASK_NOT_FOUND', msg: 'task row missing' },
      };
      return;
    }

    const historyRows = db
      .prepare(
        `SELECT chunk_idx, cues_json, quality FROM chunks WHERE task_id = ? ORDER BY chunk_idx ASC`,
      )
      .all(taskId) as { chunk_idx: number; cues_json: string; quality: string }[];
    const lastHistoryIdx = historyRows.length === 0
      ? -1
      : Math.max(...historyRows.map((r) => r.chunk_idx));

    const fromCache = task.status === 'completed';
    yield {
      event: 'status',
      data: {
        taskId,
        status:
          task.status === 'completed'
            ? 'running'
            : task.status === 'running'
              ? lastHistoryIdx >= 0
                ? 'resumed'
                : 'running'
              : task.status,
        model: task.model,
        totalChunks: task.total_chunks,
        doneChunks: lastHistoryIdx + 1,
        fromCache,
      },
    };

    let totalReplayedCues = 0;
    for (const row of historyRows) {
      const cues = JSON.parse(row.cues_json) as Cue[];
      totalReplayedCues += cues.length;
      for (const cue of cues) {
        yield {
          event: 'cue',
          data: {
            taskId,
            chunkIdx: row.chunk_idx,
            startMs: cue.startMs,
            endMs: cue.endMs,
            text: cue.text,
            quality: row.quality,
          },
        };
      }
    }

    if (task.status === 'completed') {
      yield {
        event: 'done',
        data: { taskId, totalCues: totalReplayedCues, fromCache: true },
      };
      return;
    }
    if (task.status === 'failed') {
      yield {
        event: 'error',
        data: {
          taskId,
          code: 'FATAL_UNKNOWN',
          msg: task.error_msg ?? 'previous run failed',
        },
      };
      return;
    }
    if (task.status === 'canceled') {
      return;
    }

    // Live tail: ensure worker is running, then attach to emitter
    if (!this.active || this.active.taskId !== taskId) {
      await this.tryStartNext();
    }
    if (!this.active || this.active.taskId !== taskId) {
      // Couldn't start (probably another task is active); the user must
      // reconnect. Slice 3 doesn't model wait-in-line.
      return;
    }

    const emitter = this.active.emitter;
    const buffer: SseFrame[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;

    const onFrame = (frame: SseFrame) => {
      // Drop frames already in history snapshot to avoid duplicate cues.
      if (
        (frame.event === 'cue' || frame.event === 'chunk-complete') &&
        typeof frame.data.chunkIdx === 'number' &&
        frame.data.chunkIdx <= lastHistoryIdx
      ) {
        return;
      }
      // Don't double-send the initial 'status' frame from worker if we already
      // sent one from history snapshot (we did, above).
      if (frame.event === 'status' && frame.data.fromCache !== true) {
        return;
      }
      buffer.push(frame);
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
    emitter.on('frame', onFrame);
    emitter.once('end', onEnd);

    try {
      while (true) {
        while (buffer.length > 0) {
          const f = buffer.shift()!;
          yield f;
        }
        if (finished) break;
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      emitter.off('frame', onFrame);
      emitter.off('end', onEnd);
    }
  }
}

export const transcribeQueue = new TranscribeQueue();
