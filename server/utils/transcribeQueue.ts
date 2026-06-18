/* SPDX-License-Identifier: Apache-2.0 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { ProcessAbortedError } from './process';
import { detectHallucination, type HallucinationReason } from './quality';
import { loadSettings } from './settings';
import type { SseFrame } from './sse';
import { detectSpeechSegments } from './vad';
import { serializeVtt, type Cue } from './vtt';
import type { TranscribeOptions } from './whisper';
import { extractWav, probeDurationS, transcribeChunk } from './whisper';
import { planChunksByDuration, planChunksFromVad, type ChunkPlan } from '#shared/chunking';
import type { TaskErrorCode } from '#shared/errorCodes';
import type {
  QueueActiveTask as ActiveTask,
  QueueTranscribeTaskSummary as TranscribeTaskSummary,
} from './queueTypes';
import type { ChunkRow, TranscribeTaskRow, VideoRow } from '../types/db';

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

export class TranscribeQueue {
  private active: ActiveTask | null = null;
  private pauseDepth = 0;
  // Mirrors the LLMQueue.queueEvents pattern (Slice 10): lets attach() block
  // on slot availability instead of dropping SSE when another transcribe is
  // currently active.
  private queueEvents = new EventEmitter();

  constructor() {
    this.queueEvents.setMaxListeners(100);
  }

  cancel(taskId: string): boolean {
    const db = getDb();
    const row = db
      .prepare(`SELECT status FROM transcribe_tasks WHERE id = ?`)
      .get(taskId) as Pick<TranscribeTaskRow, 'status'> | undefined;
    if (!row) return false;
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'canceled') {
      return false;
    }
    db.prepare(`UPDATE transcribe_tasks SET status='canceled' WHERE id=?`).run(taskId);
    if (this.active?.taskId === taskId) {
      this.active.abort.abort();
    }
    logEvent({ level: 'info', event: 'transcribe_canceled', taskId });
    return true;
  }

  /**
   * Returns the canonical task row for `videoSha`, creating one if none
   * exists. Idempotent for non-terminal states.
   *
   * Resurrection contract (symmetric with `TranslateQueue.ensureTask`):
   *
   *   - `completed`  → returned as-is. Caller (attach) replays history.
   *   - `running`    → returned as-is. Recovery plugin handles stale
   *                     rows at boot, so anything still `running` here
   *                     is genuinely in flight.
   *   - `queued`     → returned as-is. Already in the work queue.
   *   - `failed` / `canceled` → flipped back to `queued` so reconnecting
   *                     EventSources auto-resume. Transcription
   *                     persists chunks incrementally, so `runWorker`
   *                     resumes from the next un-done chunk rather than
   *                     redoing finished work. The dedicated retry
   *                     endpoint (`POST /api/transcribe/retry`) wipes
   *                     everything and starts fresh — use that when the
   *                     intent is "redo from scratch".
   */
  ensureTask(videoSha: string, model?: string): TranscribeTaskSummary {
    const effectiveModel = model ?? loadSettings().whisperModel;
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, video_sha, status, model, total_chunks, done_chunks, error_msg
         FROM transcribe_tasks
         WHERE video_sha = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(videoSha) as TranscribeTaskSummary | undefined;
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'canceled') {
        db.prepare(
          `UPDATE transcribe_tasks SET status='queued', error_msg=NULL WHERE id=?`,
        ).run(existing.id);
        logEvent({
          level: 'info',
          event: 'transcribe_resurrected',
          taskId: existing.id,
          fromStatus: existing.status,
        });
        existing.status = 'queued';
        existing.error_msg = null;
      }
      return existing;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
       VALUES (?, ?, 'queued', ?, ?)`,
    ).run(id, videoSha, effectiveModel, Date.now());
    return {
      id,
      video_sha: videoSha,
      status: 'queued',
      model: effectiveModel,
      total_chunks: null,
      done_chunks: 0,
      error_msg: null,
    };
  }

  async tryStartNext(): Promise<void> {
    if (this.pauseDepth > 0) return;
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
      .get() as Pick<TranscribeTaskRow, 'id' | 'video_sha' | 'model'> | undefined;
    if (!next) return;
    db.prepare(`UPDATE transcribe_tasks SET status='running' WHERE id = ?`).run(
      next.id,
    );
    // Assign `this.active` BEFORE kicking the worker: `runWorker` reads it
    // synchronously at its top. `donePromise` is overwritten with the real
    // worker promise immediately after, and `cancelActive` only reads it
    // after at least one tick.
    this.active = {
      taskId: next.id,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      donePromise: Promise.resolve(),
    };
    this.queueEvents.emit('active-changed');
    const workerPromise = this.runWorker(next.id, next.video_sha, next.model);
    this.active.donePromise = workerPromise.catch(() => {});
    workerPromise.catch((err) => {
      logEvent({
        level: 'error',
        event: 'transcribe_worker_crashed',
        taskId: next.id,
        msg: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
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
        .get(videoSha) as Pick<VideoRow, 'ext'> | undefined;
      if (!videoRow) throw new Error(`video row missing for ${videoSha}`);

      const videoPath = join(SUBCAST_PATHS.videos, `${videoSha}${videoRow.ext}`);
      await mkdir(SUBCAST_PATHS.tmp, { recursive: true });
      const wavPath = join(SUBCAST_PATHS.tmp, `${videoSha}.wav`);
      if (!existsSync(wavPath)) {
        await extractWav(videoPath, wavPath, active.abort.signal);
      }

      const durationS = await probeDurationS(wavPath, active.abort.signal);

      // Chunk planning: VAD-driven (default) or fixed-time (legacy /
      // user opt-out). VAD is deterministic on the same wav, so resuming
      // a partially-done task replays the same plan — chunk_idx → range
      // mapping stays stable across restarts.
      const settings = loadSettings();
      const strategy = settings.chunkingStrategy ?? 'vad';
      let chunkPlans: ChunkPlan[];
      if (strategy === 'vad') {
        try {
          const segments = await detectSpeechSegments(wavPath, { signal: active.abort.signal });
          chunkPlans = planChunksFromVad(segments, { maxChunkSec: CHUNK_SEC });
          logEvent({
            level: 'info',
            event: 'transcribe_vad_planned',
            taskId,
            segmentCount: segments.length,
            chunkCount: chunkPlans.length,
            coveragePct: durationS > 0
              ? Math.round(
                  (chunkPlans.reduce((s, c) => s + (c.endMs - c.startMs), 0) / (durationS * 1000)) * 100,
                )
              : 0,
          });
        } catch (err) {
          logEvent({
            level: 'warn',
            event: 'transcribe_vad_failed_fallback_fixed',
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          chunkPlans = planChunksByDuration(durationS, { maxChunkSec: CHUNK_SEC });
        }
        // VAD returned zero usable speech (silent file or false-negative
        // on a noisy track) → fall back to legacy fixed-time so the
        // user still gets a transcript attempt rather than 0 chunks.
        if (chunkPlans.length === 0) {
          logEvent({ level: 'warn', event: 'transcribe_vad_zero_segments_fallback', taskId });
          chunkPlans = planChunksByDuration(durationS, { maxChunkSec: CHUNK_SEC });
        }
      } else {
        chunkPlans = planChunksByDuration(durationS, { maxChunkSec: CHUNK_SEC });
      }

      const totalChunks = Math.max(1, chunkPlans.length);
      db.prepare(`UPDATE transcribe_tasks SET total_chunks = ? WHERE id = ?`).run(
        totalChunks,
        taskId,
      );

      const persistedChunks = db
        .prepare(
          `SELECT chunk_idx FROM chunks WHERE task_id = ? ORDER BY chunk_idx ASC`,
        )
        .all(taskId) as Pick<ChunkRow, 'chunk_idx'>[];
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

        const plan = chunkPlans[chunkIdx]!;
        const startMs = plan.startMs;
        const endMs = plan.endMs;
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
          const cues = await transcribeChunk(
            wavPath,
            chunkIdx,
            startMs / 1000,
            endMs / 1000,
            {
              model: model as TranscribeOptions['model'],
              temperature: params.temperature,
              noContext: params.noContext,
              signal: active.abort.signal,
            },
          );
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
        .all(taskId) as Pick<ChunkRow, 'cues_json'>[];
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
      await unlink(wavPath).catch((err) => {
        logEvent({
          level: 'debug',
          event: 'wav_cleanup_failed',
          path: wavPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      emit({
        event: 'done',
        data: { taskId, totalCues: allCues.length },
      });
    } catch (err) {
      // If a child process was killed because the worker was canceled,
      // the rejection surfaces as ProcessAbortedError mid-await. Map it
      // back onto the canceled path so the row doesn't end up 'failed'.
      if (err instanceof ProcessAbortedError || active.abort.signal.aborted) {
        db.prepare(`UPDATE transcribe_tasks SET status='canceled' WHERE id=?`).run(taskId);
        emit({ event: 'status', data: { taskId, status: 'canceled' } });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        // Distinguish whisper configuration errors from generic failures so
        // the UI can direct the user to fix the install instead of saying
        // "unexpected error, retry" — same pattern as the LLM workers.
        const code: TaskErrorCode =
          msg.includes('whisper-cli not built') ||
          msg.includes('Model not downloaded')
            ? 'WHISPER_NOT_CONFIGURED'
            : 'FATAL_UNKNOWN';
        db.prepare(
          `UPDATE transcribe_tasks SET status='failed', error_msg=?, error_code=? WHERE id=?`,
        ).run(msg, code, taskId);
        emit({
          event: 'error',
          data: { taskId, code, msg },
        });
      }
    } finally {
      active.emitter.emit('end');
      this.active = null;
      this.queueEvents.emit('active-changed');
      this.tryStartNext().catch((err) => {
        logEvent({
          level: 'error',
          event: 'transcribe_trystartnext_failed',
          msg: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
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
      .get(taskId) as TranscribeTaskSummary | undefined;
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
      .all(taskId) as Pick<ChunkRow, 'chunk_idx' | 'cues_json' | 'quality'>[];
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
      // Another transcribe is currently running; wait until our slot opens
      // instead of dropping the SSE (which the frontend reports as
      // "disconnected" — see useSubtitleStreams.ts).
      while (!this.active || this.active.taskId !== taskId) {
        const fresh = getDb()
          .prepare(`SELECT status FROM transcribe_tasks WHERE id=?`)
          .get(taskId) as { status?: string } | undefined;
        const s = fresh?.status;
        if (!s || s === 'completed' || s === 'failed' || s === 'canceled') {
          // Terminal in DB but we're not active — recurse so the caller hits
          // the cache-hit / error / canceled branches at the top of attach.
          yield* this.attach(taskId);
          return;
        }
        await new Promise<void>((resolve) => {
          const onChange = (): void => {
            this.queueEvents.off('active-changed', onChange);
            resolve();
          };
          this.queueEvents.once('active-changed', onChange);
        });
      }
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

  /**
   * Cancel the currently-running task, if any, and wait for the worker
   * (and its spawned children) to exit. Used by the Electron `before-quit`
   * hook so the worker stops cleanly, child processes are reaped, and its
   * DB row lands as 'canceled' rather than zombie 'running'.
   */
  async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const id = active.taskId;
    getDb().prepare(`UPDATE transcribe_tasks SET status='canceled' WHERE id=?`).run(id);
    active.abort.abort();
    logEvent({ level: 'info', event: 'transcribe_canceled', taskId: id, reason: 'shutdown' });
    await active.donePromise;
  }

  async runPaused<T>(fn: () => Promise<T> | T): Promise<T> {
    this.pauseDepth += 1;
    this.queueEvents.emit('active-changed');
    try {
      return await fn();
    } finally {
      this.pauseDepth -= 1;
      this.queueEvents.emit('active-changed');
      if (this.pauseDepth === 0) {
        this.tryStartNext().catch((err) => {
          logEvent({
            level: 'error',
            event: 'transcribe_resume_trystartnext_failed',
            msg: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        });
      }
    }
  }

  async cancelAll(reason = 'maintenance'): Promise<void> {
    const db = getDb();
    const running = db
      .prepare(`SELECT id FROM transcribe_tasks WHERE status IN ('queued','running')`)
      .all() as Array<{ id: string }>;
    if (running.length === 0) return;
    db.prepare(`UPDATE transcribe_tasks SET status='canceled' WHERE status IN ('queued','running')`)
      .run();
    const active = this.active;
    if (active) active.abort.abort();
    logEvent({
      level: 'info',
      event: 'transcribe_cancel_all',
      reason,
      count: running.length,
    });
    await active?.donePromise;
  }
}

export const transcribeQueueImpl = new TranscribeQueue();
