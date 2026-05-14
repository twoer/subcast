/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { ProcessAbortedError } from './process';
import { translateAll } from './translate';
import { detectHallucination, type HallucinationReason } from './quality';
import { loadSettings } from './settings';
import type { TranscribeOptions } from './whisper';
import { extractWav, probeDurationS, transcribeChunk } from './whisper';
import type { SseFrame } from './sse';
import { parseVtt, serializeVtt, type Cue } from './vtt';
import { buildInsightMessages } from './insights';
import { runInsightWorker, type InsightWorkerParams } from './insightTasks';
import type {
  ChunkRow,
  InsightTaskRow,
  TranscribeTaskRow,
  TranslateTaskRow,
  VideoRow,
} from '../types/db';

/**
 * Narrow view of TranscribeTaskRow returned by ensureTask / restart flows —
 * the SELECT lists drop `created_at` / `completed_at` / `language` which the
 * consumer doesn't need.
 */
export type TranscribeTaskSummary = Pick<
  TranscribeTaskRow,
  'id' | 'video_sha' | 'status' | 'model' | 'total_chunks' | 'done_chunks' | 'error_msg'
>;

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
  /**
   * Resolves when `runWorker` exits (either normally, by abort, or by
   * crash). `cancelActive()` awaits this so the shutdown path can be sure
   * spawned children have been reaped before the process exits.
   */
  donePromise: Promise<void>;
}

class TranscribeQueue {
  private active: ActiveTask | null = null;

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
      const totalChunks = Math.max(1, Math.ceil(durationS / CHUNK_SEC));
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
            model: model as TranscribeOptions['model'],
            temperature: params.temperature,
            noContext: params.noContext,
            signal: active.abort.signal,
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
        db.prepare(
          `UPDATE transcribe_tasks SET status='failed', error_msg = ? WHERE id = ?`,
        ).run(msg, taskId);
        emit({
          event: 'error',
          data: { taskId, code: 'FATAL_UNKNOWN', msg },
        });
      }
    } finally {
      active.emitter.emit('end');
      this.active = null;
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
}

export const transcribeQueue = new TranscribeQueue();

// ─────────────────────────────────────────────────────────────────────
// TranslateQueue — single-concurrent worker, priority-ordered queue.
// ─────────────────────────────────────────────────────────────────────

/**
 * Narrow view of TranslateTaskRow returned by ensureTask / restart flows.
 * SELECT lists omit `created_at` / `completed_at`.
 */
export type TranslateTaskSummary = Pick<
  TranslateTaskRow,
  'id' | 'video_sha' | 'target_lang' | 'status' | 'model' | 'progress_pct' | 'priority' | 'error_msg'
>;

export type InsightTaskSummary = Pick<
  InsightTaskRow,
  'id' | 'video_sha' | 'status' | 'model' | 'ui_language' | 'error_msg'
>;

type LLMTaskKind = 'translate' | 'insight';

export interface ActiveLLMTask {
  taskId: string;
  kind: LLMTaskKind;
  videoSha: string;
  emitter: EventEmitter;
  abort: AbortController;
  donePromise: Promise<void>;
  // translate-specific live state (used by runTranslateWorker only).
  // TODO(post-slice-9): convert ActiveLLMTask to a discriminated union by `kind`.
  // Optional fields cover both worker types in the interim. Deferred so the
  // integration slices stay focused on plumbing.
  doneCues?: Cue[];
  lang?: string;
  model?: string;
  // insight-specific: accumulated raw token stream for late-subscriber replay.
  // Append-only inside runInsightWorker; read-only in attachInsight.
  insightRaw?: string;
}

// ─────────────────────────────────────────────────────────────────────
// LLMQueue — single-concurrent worker for translate + insight tasks.
// ─────────────────────────────────────────────────────────────────────

class LLMQueue {
  private active: ActiveLLMTask | null = null;
  private queueEvents = new EventEmitter();

  constructor() {
    this.queueEvents.setMaxListeners(100);
  }

  /**
   * Returns the canonical translate task row for `(videoSha, lang)`, creating
   * one if none exists. Idempotent for non-terminal states.
   *
   * The `model` column on `translate_tasks` is purely informational now that
   * the LLM backend exposes a single active model — we record `'llm'` so
   * legacy queries still see a non-null value.
   */
  ensureTask(videoSha: string, lang: string, model?: string): TranslateTaskSummary {
    const effectiveModel = model ?? 'llm';
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, video_sha, target_lang, status, model, progress_pct, priority, error_msg
         FROM translate_tasks WHERE video_sha = ? AND target_lang = ?`,
      )
      .get(videoSha, lang) as TranslateTaskSummary | undefined;
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'canceled') {
        db.prepare(
          `UPDATE translate_tasks SET status='queued', error_msg=NULL, progress_pct=0 WHERE id=?`,
        ).run(existing.id);
        logEvent({
          level: 'info',
          event: 'translate_resurrected',
          taskId: existing.id,
          lang,
          fromStatus: existing.status,
        });
        existing.status = 'queued';
        existing.error_msg = null;
        existing.progress_pct = 0;
      }
      return existing;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO translate_tasks (id, video_sha, target_lang, status, model, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    ).run(id, videoSha, lang, effectiveModel, Date.now());
    return {
      id,
      video_sha: videoSha,
      target_lang: lang,
      status: 'queued',
      model: effectiveModel,
      progress_pct: 0,
      priority: 0,
      error_msg: null,
    };
  }

  /**
   * Returns the canonical insight task row for `(videoSha, uiLanguage)`,
   * creating one if none exists. Mirrors `ensureTask`'s resurrection pattern
   * but uses the insight status vocabulary: `'error'`/`'canceled'` flip back
   * to `'queued'`. (Translate uses `'failed'`/`'canceled'` — do not conflate.)
   */
  ensureInsightTask(
    videoSha: string,
    uiLanguage: 'zh-CN' | 'en',
    model: string,
  ): InsightTaskSummary {
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, video_sha, status, model, ui_language, error_msg
         FROM insight_tasks WHERE video_sha = ? AND ui_language = ?`,
      )
      .get(videoSha, uiLanguage) as InsightTaskSummary | undefined;
    if (existing) {
      if (existing.status === 'error' || existing.status === 'canceled') {
        db.prepare(
          `UPDATE insight_tasks SET status='queued', error_msg=NULL WHERE id=?`,
        ).run(existing.id);
        logEvent({
          level: 'info',
          event: 'insight_resurrected',
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
      `INSERT INTO insight_tasks (id, video_sha, status, model, ui_language, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    ).run(id, videoSha, model, uiLanguage, Date.now());
    return {
      id,
      video_sha: videoSha,
      status: 'queued',
      model,
      ui_language: uiLanguage,
      error_msg: null,
    };
  }

  /**
   * Bump translate task to top of pending queue per F4 priority insert. The
   * currently running task is NOT preempted; this only affects the next dequeue.
   */
  bumpPriority(taskId: string): void {
    const db = getDb();
    const max = db
      .prepare(`SELECT COALESCE(MAX(priority), 0) AS m FROM translate_tasks`)
      .get() as { m: number };
    db.prepare(`UPDATE translate_tasks SET priority = ? WHERE id = ?`).run(
      max.m + 1,
      taskId,
    );
  }

  cancel(taskId: string): boolean {
    const db = getDb();
    const tRow = db
      .prepare(`SELECT status FROM translate_tasks WHERE id=?`)
      .get(taskId) as Pick<TranslateTaskRow, 'status'> | undefined;
    if (tRow) {
      if (tRow.status === 'completed' || tRow.status === 'failed' || tRow.status === 'canceled') {
        return false;
      }
      db.prepare(`UPDATE translate_tasks SET status='canceled' WHERE id=?`).run(taskId);
      if (this.active?.taskId === taskId) this.active.abort.abort();
      logEvent({ level: 'info', event: 'translate_canceled', taskId });
      return true;
    }
    const iRow = db
      .prepare(`SELECT status FROM insight_tasks WHERE id=?`)
      .get(taskId) as Pick<InsightTaskRow, 'status'> | undefined;
    if (iRow) {
      if (iRow.status === 'done' || iRow.status === 'error' || iRow.status === 'canceled') {
        return false;
      }
      db.prepare(
        `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`,
      ).run(Date.now(), taskId);
      if (this.active?.taskId === taskId) this.active.abort.abort();
      logEvent({ level: 'info', event: 'insight_canceled', taskId });
      return true;
    }
    return false;
  }

  async tryStartNext(): Promise<void> {
    if (this.active) return;
    const db = getDb();
    const next = db
      .prepare(
        `SELECT id, kind, video_sha, created_at FROM (
           SELECT id, 'translate' AS kind, video_sha, created_at,
                  priority AS sort_priority
           FROM translate_tasks WHERE status='queued'
           UNION ALL
           SELECT id, 'insight' AS kind, video_sha, created_at,
                  0 AS sort_priority
           FROM insight_tasks WHERE status='queued'
         )
         ORDER BY sort_priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get() as { id: string; kind: LLMTaskKind; video_sha: string; created_at: number } | undefined;
    if (!next) return;

    if (next.kind === 'translate') {
      return this.startTranslate(next.id);
    } else {
      return this.startInsight(next.id);
    }
  }

  private async startTranslate(taskId: string): Promise<void> {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, video_sha, target_lang, model
         FROM translate_tasks WHERE id = ?`,
      )
      .get(taskId) as { id: string; video_sha: string; target_lang: string; model: string };
    db.prepare(`UPDATE translate_tasks SET status='running' WHERE id=?`).run(taskId);
    const activeSlot: ActiveLLMTask = {
      taskId,
      kind: 'translate',
      videoSha: row.video_sha,
      lang: row.target_lang,
      model: row.model,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      doneCues: [],
      donePromise: Promise.resolve(),
    };
    this.active = activeSlot;
    this.queueEvents.emit('active-changed');
    const wp = this.runTranslateWorker(activeSlot);
    activeSlot.donePromise = wp.catch(() => {});
    wp.catch((err) => {
      logEvent({
        level: 'error',
        event: 'llm_worker_crashed',
        kind: 'translate',
        taskId,
        msg: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
  }

  private async startInsight(taskId: string): Promise<void> {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, video_sha, model, ui_language
         FROM insight_tasks WHERE id = ?`,
      )
      .get(taskId) as {
        id: string;
        video_sha: string;
        model: string;
        ui_language: 'zh-CN' | 'en';
      };
    const origPath = join(SUBCAST_PATHS.cache, row.video_sha, 'original.vtt');
    if (!existsSync(origPath)) {
      db.prepare(
        `UPDATE insight_tasks SET status='error', error_msg=?, completed_at=? WHERE id=?`,
      ).run('ORIGINAL_NOT_READY', Date.now(), taskId);
      return this.tryStartNext();
    }
    const transcript = readFileSync(origPath, 'utf-8');
    const cues = parseVtt(transcript);
    const messages = buildInsightMessages(transcript, row.ui_language);

    db.prepare(`UPDATE insight_tasks SET status='running' WHERE id=?`).run(taskId);
    this.active = {
      taskId,
      kind: 'insight',
      videoSha: row.video_sha,
      model: row.model,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      donePromise: Promise.resolve(),
    };
    this.queueEvents.emit('active-changed');
    const params: InsightWorkerParams = {
      videoSha: row.video_sha,
      model: row.model,
      uiLanguage: row.ui_language,
      messages,
      cues,
    };
    // IIFE owns the queue lifecycle (emit 'end', clear active slot, nudge next)
    // so runInsightWorker stays decoupled from LLMQueue internals. Translate's
    // equivalent lives inside runTranslateWorker because that worker pre-dates
    // the LLMQueue split and was moved wholesale.
    const wp = (async () => {
      try {
        await runInsightWorker(this.active!, params);
      } finally {
        this.active!.emitter.emit('end');
        this.active = null;
        this.queueEvents.emit('active-changed');
        this.tryStartNext().catch((err) => {
          logEvent({
            level: 'error',
            event: 'llm_trystartnext_failed',
            msg: err instanceof Error ? err.message : String(err),
          });
        });
      }
    })();
    this.active.donePromise = wp.catch(() => {});
    wp.catch((err) => {
      logEvent({
        level: 'error',
        event: 'llm_worker_crashed',
        kind: 'insight',
        taskId,
        msg: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
  }

  /**
   * Block until `this.active.taskId === taskId` becomes true, the task row's
   * status becomes terminal, or the `signal` aborts. Returns the new state so
   * the caller can decide what to do next.
   */
  private async waitForSlot(
    taskId: string,
    getStatus: () => string | undefined,
    signal: AbortSignal,
  ): Promise<'active' | 'terminal' | 'aborted'> {
    while (true) {
      if (signal.aborted) return 'aborted';
      if (this.active?.taskId === taskId) return 'active';
      const status = getStatus();
      if (
        !status ||
        status === 'canceled' ||
        status === 'failed' ||
        status === 'error' ||
        status === 'completed' ||
        status === 'done'
      ) {
        return 'terminal';
      }
      await new Promise<void>((resolve) => {
        const onChange = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          this.queueEvents.off('active-changed', onChange);
          signal.removeEventListener('abort', onAbort);
        };
        this.queueEvents.once('active-changed', onChange);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private async runTranslateWorker(active: ActiveLLMTask): Promise<void> {
    const taskId = active.taskId;
    const videoSha = active.videoSha;
    const lang = active.lang!;
    const model = active.model!;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);

    try {
      const origPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');
      if (!existsSync(origPath)) {
        throw new Error('ORIGINAL_NOT_READY');
      }
      const origCues = parseVtt(readFileSync(origPath, 'utf8'));
      const totalBatches = Math.max(1, Math.ceil(origCues.length / 40));

      emit({
        event: 'status',
        data: { taskId, status: 'running', model, lang, fromCache: false, totalBatches },
      });

      const out = await translateAll(origCues, lang, {
        signal: active.abort.signal,
        onSuperBatchStart: (info) => {
          emit({
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
          active.doneCues!.push(...info.cues);
          emit({
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
          const pct = Math.round(((info.batchIdx + 1) / info.totalBatches) * 100);
          emit({
            event: 'batch-progress',
            data: {
              taskId,
              doneBatches: info.batchIdx + 1,
              totalBatches: info.totalBatches,
              progressPct: pct,
            },
          });
          db.prepare(`UPDATE translate_tasks SET progress_pct = ? WHERE id = ?`).run(
            pct,
            taskId,
          );
        },
        onBatchRetry: (info) => {
          emit({
            event: 'batch-retry',
            data: {
              taskId,
              batchIdx: info.batchIdx,
              attempt: info.attempt,
              reason: info.reason,
            },
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

      emit({ event: 'done', data: { taskId, totalCues: out.length } });
      logEvent({
        level: 'info',
        event: 'translate_completed',
        taskId,
        lang,
        cues: out.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        msg === 'CANCELED' || active.abort.signal.aborted
          ? 'CANCELED'
          : msg.startsWith('BATCH_RETRY_EXHAUSTED')
            ? 'BATCH_RETRY_EXHAUSTED'
            : msg === 'ORIGINAL_NOT_READY'
              ? 'ORIGINAL_NOT_READY'
              : 'FATAL_UNKNOWN';
      if (code === 'CANCELED') {
        // status row already 'canceled' by cancel()
        emit({ event: 'status', data: { taskId, status: 'canceled' } });
      } else {
        db.prepare(`UPDATE translate_tasks SET status='failed', error_msg=? WHERE id=?`)
          .run(msg, taskId);
        emit({ event: 'error', data: { taskId, code, msg } });
      }
      logEvent({ level: 'error', event: 'translate_failed', taskId, lang, code, msg });
    } finally {
      active.emitter.emit('end');
      this.active = null;
      this.queueEvents.emit('active-changed');
      // The llama-server backend auto-unloads on idle (see llmServer.ts),
      // so the queue no longer needs to send an explicit unload signal.
      this.tryStartNext().catch((err) => {
        logEvent({
          level: 'error',
          event: 'translate_trystartnext_failed',
          msg: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      });
    }
  }

  async *attach(taskId: string): AsyncIterable<SseFrame> {
    const db = getDb();
    const tRow = db
      .prepare(`SELECT 1 FROM translate_tasks WHERE id=?`)
      .get(taskId);
    if (tRow) {
      yield* this.attachTranslate(taskId);
      return;
    }
    const iRow = db
      .prepare(`SELECT 1 FROM insight_tasks WHERE id=?`)
      .get(taskId);
    if (iRow) {
      yield* this.attachInsight(taskId);
      return;
    }
    yield {
      event: 'error',
      data: { taskId, code: 'TASK_NOT_FOUND', msg: 'task row missing' },
    };
  }

  private async *attachTranslate(taskId: string): AsyncIterable<SseFrame> {
    const db = getDb();
    const task = db
      .prepare(
        `SELECT id, video_sha, target_lang, status, model, progress_pct, priority, error_msg
         FROM translate_tasks WHERE id = ?`,
      )
      .get(taskId) as TranslateTaskSummary | undefined;
    if (!task) {
      yield {
        event: 'error',
        data: { taskId, code: 'TASK_NOT_FOUND', msg: 'translate task missing' },
      };
      return;
    }

    const vttPath = join(SUBCAST_PATHS.cache, task.video_sha, `${task.target_lang}.vtt`);
    if (task.status === 'completed') {
      if (existsSync(vttPath)) {
        const cues = parseVtt(await readFile(vttPath, 'utf8'));
        yield {
          event: 'status',
          data: {
            taskId,
            status: 'running',
            model: task.model,
            lang: task.target_lang,
            fromCache: true,
          },
        };
        yield {
          event: 'cue-translated',
          data: {
            taskId,
            batchIdx: 0,
            cues: cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
          },
        };
        yield { event: 'done', data: { taskId, totalCues: cues.length, fromCache: true } };
        return;
      }
      // File missing — self-heal: demote back to queued and re-run.
      logEvent({
        level: 'warn',
        event: 'result_file_missing_resurrect',
        kind: 'translate',
        taskId,
        expectedPath: vttPath,
      });
      getDb()
        .prepare(
          `UPDATE translate_tasks SET status='queued', progress_pct=0, error_msg=NULL WHERE id=?`,
        )
        .run(taskId);
      yield { event: 'status', data: { taskId, status: 'queued' } };
      await this.tryStartNext();
      // Fall through to live-tail below (don't return)
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
      yield { event: 'status', data: { taskId, status: 'canceled' } };
      return;
    }

    // queued / running — surface initial state, then live-tail emitter
    if (task.status === 'queued' && (!this.active || this.active.taskId !== taskId)) {
      yield {
        event: 'status',
        data: {
          taskId,
          status: 'queued',
          model: task.model,
          lang: task.target_lang,
          fromCache: false,
        },
      };
    }

    if (!this.active || this.active.taskId !== taskId) {
      await this.tryStartNext();
    }
    if (!this.active || this.active.taskId !== taskId) {
      // Another task is currently running; wait until our slot opens.
      const waitAbort = new AbortController();
      const result = await this.waitForSlot(
        taskId,
        () =>
          (
            getDb()
              .prepare(`SELECT status FROM translate_tasks WHERE id=?`)
              .get(taskId) as { status?: string } | undefined
          )?.status,
        waitAbort.signal,
      );
      if (result === 'terminal') {
        const fresh = getDb()
          .prepare(`SELECT status, error_msg FROM translate_tasks WHERE id=?`)
          .get(taskId) as { status: string; error_msg: string | null } | undefined;
        if (fresh?.status === 'completed') {
          yield* this.attachTranslate(taskId);
        } else if (fresh?.status === 'canceled') {
          yield { event: 'status', data: { taskId, status: 'canceled' } };
        } else {
          yield {
            event: 'error',
            data: {
              taskId,
              code: 'FATAL_UNKNOWN',
              msg: fresh?.error_msg ?? 'previous run failed',
            },
          };
        }
        return;
      }
      if (result === 'aborted') return;
      // result === 'active': fall through to live tail
    }

    // Live tail
    const live = this.active!;
    if (task.progress_pct > 0) {
      yield {
        event: 'batch-progress',
        data: { taskId, progressPct: task.progress_pct },
      };
    }
    if (live.doneCues && live.doneCues.length > 0) {
      yield {
        event: 'cue-translated',
        data: {
          taskId,
          batchIdx: -1,
          cues: live.doneCues.map((c) => ({
            startMs: c.startMs,
            endMs: c.endMs,
            text: c.text,
          })),
        },
      };
    }

    const buffer: SseFrame[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    const onFrame = (f: SseFrame) => {
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
    live.emitter.on('frame', onFrame);
    live.emitter.once('end', onEnd);
    try {
      while (true) {
        while (buffer.length > 0) yield buffer.shift()!;
        if (finished) break;
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      live.emitter.off('frame', onFrame);
      live.emitter.off('end', onEnd);
    }
  }

  private async *attachInsight(taskId: string): AsyncIterable<SseFrame> {
    const db = getDb();
    const task = db
      .prepare(
        `SELECT id, video_sha, status, model, ui_language, error_msg
         FROM insight_tasks WHERE id=?`,
      )
      .get(taskId) as InsightTaskSummary | undefined;
    if (!task) {
      yield {
        event: 'error',
        data: { taskId, code: 'TASK_NOT_FOUND', message: 'insight task missing' },
      };
      return;
    }

    yield {
      event: 'start',
      data: {
        taskId,
        model: task.model,
        uiLanguage: task.ui_language,
        status: task.status,
      },
    };

    if (task.status === 'done') {
      const path = join(SUBCAST_PATHS.cache, task.video_sha, 'insights.json');
      if (existsSync(path)) {
        const obj = JSON.parse(readFileSync(path, 'utf-8'));
        yield { event: 'done', data: { insights: obj, fromCache: true } };
        return;
      }
      // File missing — self-heal: demote back to queued and re-run.
      logEvent({
        level: 'warn',
        event: 'result_file_missing_resurrect',
        kind: 'insight',
        taskId,
        expectedPath: path,
      });
      getDb()
        .prepare(`UPDATE insight_tasks SET status='queued', error_msg=NULL WHERE id=?`)
        .run(taskId);
      yield { event: 'status', data: { taskId, status: 'queued' } };
      await this.tryStartNext();
      // Fall through to live-tail (re-fetch task status, continue normally)
      task.status = 'queued';
    }
    if (task.status === 'error') {
      yield {
        event: 'error',
        data: { taskId, code: 'PARSE_FAILED', message: task.error_msg ?? 'previous run failed' },
      };
      return;
    }
    if (task.status === 'canceled') {
      yield { event: 'error', data: { taskId, code: 'CANCELED' } };
      return;
    }

    // queued / running — status already included in the 'start' frame above.
    if (!this.active || this.active.taskId !== taskId) {
      await this.tryStartNext();
    }
    if (!this.active || this.active.taskId !== taskId) {
      // Another task is currently running; wait until our slot opens.
      const waitAbort = new AbortController();
      const result = await this.waitForSlot(
        taskId,
        () =>
          (
            getDb()
              .prepare(`SELECT status FROM insight_tasks WHERE id=?`)
              .get(taskId) as { status?: string } | undefined
          )?.status,
        waitAbort.signal,
      );
      if (result === 'terminal') {
        const fresh = getDb()
          .prepare(`SELECT status, error_msg FROM insight_tasks WHERE id=?`)
          .get(taskId) as { status: string; error_msg: string | null } | undefined;
        if (fresh?.status === 'done') {
          yield* this.attachInsight(taskId);
        } else if (fresh?.status === 'canceled') {
          yield { event: 'error', data: { taskId, code: 'CANCELED' } };
        } else {
          yield {
            event: 'error',
            data: {
              taskId,
              code: 'PARSE_FAILED',
              message: fresh?.error_msg ?? 'previous run failed',
            },
          };
        }
        return;
      }
      if (result === 'aborted') return;
      // result === 'active': fall through to live tail
    }

    const live = this.active!;
    const buffer: SseFrame[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;
    const onFrame = (f: SseFrame) => {
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
    live.emitter.on('frame', onFrame);
    live.emitter.once('end', onEnd);

    // Late-subscriber token replay: emit accumulated tokens as a single frame
    // so reconnects and concurrent subscribers don't miss tokens emitted before
    // the listener was registered.
    if (live.insightRaw) {
      yield { event: 'token', data: { text: live.insightRaw } };
    }

    try {
      while (true) {
        while (buffer.length > 0) yield buffer.shift()!;
        if (finished) break;
        await new Promise<void>((r) => {
          resolveNext = r;
        });
      }
    } finally {
      live.emitter.off('frame', onFrame);
      live.emitter.off('end', onEnd);
    }
  }

  /**
   * Cancel the currently-running LLM task, if any, and wait for the worker
   * to exit. Used by the Electron `before-quit` hook so the DB doesn't carry
   * a 'running' row across launches.
   */
  async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const id = active.taskId;
    const kind = active.kind;
    const db = getDb();
    if (kind === 'translate') {
      db.prepare(`UPDATE translate_tasks SET status='canceled' WHERE id=?`).run(id);
    } else {
      db.prepare(
        `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`,
      ).run(Date.now(), id);
    }
    active.abort.abort();
    logEvent({ level: 'info', event: 'llm_canceled', kind, taskId: id, reason: 'shutdown' });
    await active.donePromise;
  }
}

export const llmQueue = new LLMQueue();

class TranslateQueueFacade {
  ensureTask(videoSha: string, lang: string, model?: string): TranslateTaskSummary {
    return llmQueue.ensureTask(videoSha, lang, model);
  }
  bumpPriority(taskId: string): void {
    llmQueue.bumpPriority(taskId);
  }
  cancel(taskId: string): boolean {
    return llmQueue.cancel(taskId);
  }
  async tryStartNext(): Promise<void> {
    return llmQueue.tryStartNext();
  }
  attach(taskId: string) {
    return llmQueue.attach(taskId);
  }
  async cancelActive(): Promise<void> {
    return llmQueue.cancelActive();
  }
}

export const translateQueue = new TranslateQueueFacade();
