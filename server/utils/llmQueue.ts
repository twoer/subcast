/* SPDX-License-Identifier: Apache-2.0 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { buildInsightMessages } from './insights';
import { runInsightWorker, type InsightWorkerParams } from './insightTasks';
import { translateAll } from './translate';
import { parseVtt, serializeVtt } from './vtt';
import { isLlmConfigError, type TaskErrorCode } from '#shared/errorCodes';
import type { SseFrame } from './sse';
import type {
  QueueActiveLLMTask as ActiveLLMTask,
  QueueInsightTaskSummary as InsightTaskSummary,
  QueueLLMTaskKind as LLMTaskKind,
  QueueTranslateTaskSummary as TranslateTaskSummary,
} from './queueTypes';
import type { InsightTaskRow, TranslateTaskRow } from '../types/db';

// ─────────────────────────────────────────────────────────────────────
// LLMQueue — single-concurrent worker for translate + insight tasks.
// ─────────────────────────────────────────────────────────────────────

export class LLMQueue {
  private active: ActiveLLMTask | null = null;
  private pauseDepth = 0;
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
    if (this.pauseDepth > 0) return;
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
        `UPDATE insight_tasks SET status='error', error_msg=?, error_code='ORIGINAL_NOT_READY', completed_at=? WHERE id=?`,
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
      const code: TaskErrorCode | 'CANCELED' =
        msg === 'CANCELED' || active.abort.signal.aborted
          ? 'CANCELED'
          : msg.startsWith('BATCH_RETRY_EXHAUSTED')
            ? 'BATCH_RETRY_EXHAUSTED'
            : msg === 'ORIGINAL_NOT_READY'
              ? 'ORIGINAL_NOT_READY'
              : isLlmConfigError(msg)
                ? 'MODEL_NOT_CONFIGURED'
                : 'FATAL_UNKNOWN';
      if (code === 'CANCELED') {
        // status row already 'canceled' by cancel()
        emit({ event: 'status', data: { taskId, status: 'canceled' } });
      } else {
        db.prepare(`UPDATE translate_tasks SET status='failed', error_msg=?, error_code=? WHERE id=?`)
          .run(msg, code, taskId);
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
            event: 'llm_resume_trystartnext_failed',
            msg: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        });
      }
    }
  }

  async cancelAll(reason = 'maintenance'): Promise<void> {
    const db = getDb();
    const translateCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM translate_tasks WHERE status IN ('queued','running')`)
        .get() as { n: number }
    ).n;
    const insightCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM insight_tasks WHERE status IN ('queued','running')`)
        .get() as { n: number }
    ).n;
    if (translateCount + insightCount === 0) return;
    db.prepare(
      `UPDATE translate_tasks SET status='canceled' WHERE status IN ('queued','running')`,
    ).run();
    db.prepare(
      `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE status IN ('queued','running')`,
    ).run(Date.now());
    const active = this.active;
    if (active) active.abort.abort();
    logEvent({
      level: 'info',
      event: 'llm_cancel_all',
      reason,
      translateCount,
      insightCount,
    });
    await active?.donePromise;
  }
}

export const llmQueueImpl = new LLMQueue();

export class TranslateQueueFacade {
  ensureTask(videoSha: string, lang: string, model?: string): TranslateTaskSummary {
    return llmQueueImpl.ensureTask(videoSha, lang, model);
  }
  bumpPriority(taskId: string): void {
    llmQueueImpl.bumpPriority(taskId);
  }
  cancel(taskId: string): boolean {
    return llmQueueImpl.cancel(taskId);
  }
  async tryStartNext(): Promise<void> {
    return llmQueueImpl.tryStartNext();
  }
  attach(taskId: string) {
    return llmQueueImpl.attach(taskId);
  }
  async cancelActive(): Promise<void> {
    return llmQueueImpl.cancelActive();
  }
}

export const translateQueueImpl = new TranslateQueueFacade();
