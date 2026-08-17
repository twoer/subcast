/* SPDX-License-Identifier: Apache-2.0 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { sanitizeUserErrorMessage } from './logSanitize';
import { buildInsightMessages } from './insights';
import { runInsightWorker, type InsightWorkerParams } from './insightTasks';
import {
  polishAll,
  polishOneBatch,
  BATCH_SIZE as POLISH_BATCH_SIZE,
} from './polish';
import { loadSettings } from './settings';
import {
  translateAll,
  translateSuperBatch,
  SUPER_BATCH_SIZE,
} from './translate';
import {
  buildInsightInvocationSpec,
  buildPolishInvocationSpec,
  buildTranslateInvocationSpec,
  invocationFingerprint,
  type InvocationSpec,
} from './invocationSpec';
import {
  buildInsightArtifactFingerprint,
} from './artifactFingerprint';
import { selectTaskModel, TASK_MODEL_POLICY_ID } from './taskModelPolicy';
import { readLatestInsightArtifact } from './artifactStore';
import {
  pipelineReadyShas,
  pollTranscriptSource,
  runningTranscribeTask,
  type TranscriptSourcePollState,
  type TranscriptSourceSnapshot,
} from './transcriptSource';
import { parseVtt, serializeVtt, type Cue } from './vtt';
import { getLlmServer } from './llmServer';
import { activeRuntimeProfile } from './runtimeProfile';
import { isLlmConfigError, type TaskErrorCode } from '#shared/errorCodes';
import { POLISH_LAYER_LANG } from '#shared/polishLayer';
import type { SseFrame } from './sse';
import { isLlmModelId, type LlmModelId, type LlmTaskKind } from '#shared/llmModels';
import type {
  QueueActiveLLMTask as ActiveLLMTask,
  QueueInsightTaskSummary as InsightTaskSummary,
  QueueLLMTaskKind as LLMTaskKind,
  QueuePolishTaskSummary as PolishTaskSummary,
  QueueTranslateTaskSummary as TranslateTaskSummary,
} from './queueTypes';
import type { InsightTaskRow, PolishTaskRow, TranslateTaskRow } from '../types/db';

/**
 * How often a pipelined worker re-reads the chunks table for new cues.
 * Env-tunable so tests can shrink it (batch latency dominates in
 * production; a 1 s poll adds negligible jitter there).
 */
const PIPELINE_POLL_MS = Number(process.env.SUBCAST_PIPELINE_POLL_MS ?? 1_000);

// ─────────────────────────────────────────────────────────────────────
// LLMQueue — slot-based concurrent worker for translate + polish +
// insight tasks. Up to the active runtime profile's `parallelSlots`
// tasks run at once — exactly what llama-server is spawned with, so two
// translate/polish batches decode in one forward pass. At most ONE
// insight runs at a time: two of their ~3-6k-token prompts plus
// 4096-token output budgets would contend with each other's decode for
// minutes at a stretch. While one insight runs, the other slot keeps
// serving translate/polish batches — a user-requested summary no
// longer stalls the whole queue for its (up to ~235 s) duration.
//
// Translate/polish run either batched (original.vtt exists — unchanged
// pre-P6 behavior) or pipelined (P6): while their video is still being
// transcribed they consume cues from the chunks table as chunks land,
// so total wall time approaches max(T_asr, T_llm) instead of the sum.
// Pipelined tasks only dequeue once their source has produced a full
// super-batch of cues (see transcriptSource.pipelineReadyShas).
// ─────────────────────────────────────────────────────────────────────

/**
 * Head of the pending queue across all three LLM task tables. Ordering
 * is FIFO by created_at; translate's dynamic `priority` column is the
 * only way to jump the line (bumped when a user attaches to the task's
 * SSE stream). Polish used to hard-code priority 1 here — auto-polish
 * of freshly transcribed videos kept leap-frogging translations the
 * user had already queued.
 *
 * `readyShas` (P6) gates translate/polish rows on their video's source
 * readiness; insight rows are exempt (they need the finished transcript
 * and fail fast on their own).
 */
export function pickNextLlmTask(
  excludeInsight: boolean,
  readyShas?: ReadonlySet<string>,
): { id: string; kind: LLMTaskKind; video_sha: string } | undefined {
  const db = getDb();
  const params: string[] = [];
  const conds: string[] = [];
  if (excludeInsight) conds.push(`kind != 'insight'`);
  if (readyShas !== undefined) {
    if (readyShas.size === 0) {
      conds.push(`kind = 'insight'`);
    } else {
      const placeholders = Array.from(readyShas, () => '?').join(',');
      conds.push(`(kind = 'insight' OR video_sha IN (${placeholders}))`);
      params.push(...readyShas);
    }
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT id, kind, video_sha FROM (
         SELECT id, 'translate' AS kind, video_sha, created_at,
                priority AS sort_priority
         FROM translate_tasks WHERE status='queued'
         UNION ALL
         SELECT id, 'polish' AS kind, video_sha, created_at,
                0 AS sort_priority
         FROM polish_tasks WHERE status='queued'
         UNION ALL
         SELECT id, 'insight' AS kind, video_sha, created_at,
                0 AS sort_priority
         FROM insight_tasks WHERE status='queued'
       ) ${where}
       ORDER BY sort_priority DESC, created_at ASC
       LIMIT 1`,
    )
    .get(...params) as { id: string; kind: LLMTaskKind; video_sha: string } | undefined;
}

export function llmMaxActiveSlots(): number {
  return activeRuntimeProfile().parallelSlots;
}

function sourceRevisionForVideo(videoSha: string): string {
  return `video:${videoSha}`;
}

function serializeSpec(spec: InvocationSpec | null): string | null {
  return spec ? JSON.stringify(spec) : null;
}

function specFingerprint(spec: InvocationSpec | null): string | null {
  return spec ? invocationFingerprint(spec) : null;
}

function resolveInvocationModel(
  model: string | undefined,
  settingsModel: LlmModelId | undefined,
): LlmModelId | undefined {
  return isLlmModelId(model) ? model : settingsModel;
}

function invocationPolicy(
  task: LlmTaskKind,
  configuredModel: LlmModelId | undefined,
): ReturnType<typeof selectTaskModel> | null {
  return configuredModel
    ? selectTaskModel({ task, configuredModel, dryRun: false })
    : null;
}

function policyFieldsFromSpecJson(
  specJson: string | null | undefined,
  fallbackTask: LlmTaskKind,
): { taskRole: LlmTaskKind; policyId: string } {
  if (specJson) {
    try {
      const parsed = JSON.parse(specJson) as Partial<InvocationSpec>;
      return {
        taskRole: parsed.taskRole ?? fallbackTask,
        policyId: parsed.policyId ?? TASK_MODEL_POLICY_ID,
      };
    } catch {
      // Fall through to the compatibility defaults below.
    }
  }
  return { taskRole: fallbackTask, policyId: TASK_MODEL_POLICY_ID };
}

function userVisibleLlmErrorMessage(code: TaskErrorCode | 'CANCELED', msg: string): string {
  if (code === 'MODEL_NOT_CONFIGURED') {
    return 'Local LLM model is not configured or unavailable.';
  }
  return sanitizeUserErrorMessage(msg);
}

export class LLMQueue {
  private activeSlots: ActiveLLMTask[] = [];
  private pauseDepth = 0;
  private queueEvents = new EventEmitter();
  /** Task ids whose pipelined dispatch already fired an LLM prewarm. */
  private prewarmed = new Set<string>();

  constructor() {
    this.queueEvents.setMaxListeners(100);
  }

  private findSlot(taskId: string): ActiveLLMTask | undefined {
    return this.activeSlots.find((t) => t.taskId === taskId);
  }

  private hasInsightSlot(): boolean {
    return this.activeSlots.some((t) => t.kind === 'insight');
  }

  private maxActiveSlots(): number {
    return llmMaxActiveSlots();
  }

  private releaseSlot(taskId: string): void {
    const before = this.activeSlots.length;
    this.activeSlots = this.activeSlots.filter((t) => t.taskId !== taskId);
    if (this.activeSlots.length !== before) {
      this.queueEvents.emit('active-changed');
    }
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
    const db = getDb();
    const { llmModel } = loadSettings();
    const invocationModel = resolveInvocationModel(model, llmModel);
    const policy = invocationPolicy('translate', invocationModel);
    const effectiveModel = policy?.modelId ?? model ?? llmModel ?? 'llm';
    const spec = policy
      ? buildTranslateInvocationSpec({
          modelId: policy.modelId,
          taskRole: policy.task,
          policyId: policy.policyId,
          policyReason: policy.reason,
          sourceRevision: sourceRevisionForVideo(videoSha),
          language: lang,
        })
      : null;
    const specJson = serializeSpec(spec);
    const fingerprint = specFingerprint(spec);
    const existing = db
      .prepare(
        `SELECT id, video_sha, target_lang, status, model, progress_pct, priority, error_msg,
                invocation_spec_json, invocation_fingerprint
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
      `INSERT INTO translate_tasks (
         id, video_sha, target_lang, status, model,
         invocation_spec_json, invocation_fingerprint, created_at
       )
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(id, videoSha, lang, effectiveModel, specJson, fingerprint, Date.now());
    return {
      id,
      video_sha: videoSha,
      target_lang: lang,
      status: 'queued',
      model: effectiveModel,
      progress_pct: 0,
      priority: 0,
      error_msg: null,
      invocation_spec_json: specJson,
      invocation_fingerprint: fingerprint,
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
    model: LlmModelId,
    sourceRevision = sourceRevisionForVideo(videoSha),
  ): InsightTaskSummary {
    const db = getDb();
    const policy = selectTaskModel({ task: 'insight', configuredModel: model, dryRun: false });
    const spec = buildInsightInvocationSpec({
      modelId: policy.modelId,
      taskRole: policy.task,
      policyId: policy.policyId,
      policyReason: policy.reason,
      sourceRevision,
      uiLanguage,
    });
    const specJson = serializeSpec(spec);
    const fingerprint = specFingerprint(spec);
    const existing = db
      .prepare(
        `SELECT id, video_sha, status, model, ui_language, error_msg,
                invocation_spec_json, invocation_fingerprint
         FROM insight_tasks
         WHERE video_sha = ? AND ui_language = ? AND invocation_fingerprint = ?`,
      )
      .get(videoSha, uiLanguage, fingerprint) as InsightTaskSummary | undefined;
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
      `INSERT INTO insight_tasks (
         id, video_sha, status, model, ui_language,
         invocation_spec_json, invocation_fingerprint, created_at
       )
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(id, videoSha, policy.modelId, uiLanguage, specJson, fingerprint, Date.now());
    return {
      id,
      video_sha: videoSha,
      status: 'queued',
      model: policy.modelId,
      ui_language: uiLanguage,
      error_msg: null,
      invocation_spec_json: specJson,
      invocation_fingerprint: fingerprint,
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

  /**
   * Canonical polish task for a video (one polished layer per sha — no
   * target-lang dimension). Translate-style status vocabulary. Re-enqueues
   * failed/canceled rows so the player's manual "AI 润色" button doubles as
   * the retry path.
   */
  ensurePolishTask(videoSha: string, model?: string): PolishTaskSummary {
    const db = getDb();
    const settings = loadSettings();
    const invocationModel = resolveInvocationModel(model, settings.llmModel);
    const policy = invocationPolicy('polish', invocationModel);
    const effectiveModel = policy?.modelId ?? model ?? settings.llmModel ?? 'llm';
    const spec = policy
      ? buildPolishInvocationSpec({
          modelId: policy.modelId,
          taskRole: policy.task,
          policyId: policy.policyId,
          policyReason: policy.reason,
          sourceRevision: sourceRevisionForVideo(videoSha),
          hints: settings.polishHints,
        })
      : null;
    const specJson = serializeSpec(spec);
    const fingerprint = specFingerprint(spec);
    const existing = db
      .prepare(
        `SELECT id, video_sha, status, model, progress_pct, error_msg,
                invocation_spec_json, invocation_fingerprint
         FROM polish_tasks WHERE video_sha = ?`,
      )
      .get(videoSha) as PolishTaskSummary | undefined;
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'canceled') {
        db.prepare(
          `UPDATE polish_tasks SET status='queued', error_msg=NULL, progress_pct=0 WHERE id=?`,
        ).run(existing.id);
        logEvent({
          level: 'info',
          event: 'polish_resurrected',
          taskId: existing.id,
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
      `INSERT INTO polish_tasks (
         id, video_sha, status, model,
         invocation_spec_json, invocation_fingerprint, created_at
       )
       VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(id, videoSha, effectiveModel, specJson, fingerprint, Date.now());
    return {
      id,
      video_sha: videoSha,
      status: 'queued',
      model: effectiveModel,
      progress_pct: 0,
      error_msg: null,
      invocation_spec_json: specJson,
      invocation_fingerprint: fingerprint,
    };
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
      this.findSlot(taskId)?.abort.abort();
      logEvent({ level: 'info', event: 'translate_canceled', taskId });
      return true;
    }
    const pRow = db
      .prepare(`SELECT status FROM polish_tasks WHERE id=?`)
      .get(taskId) as Pick<PolishTaskRow, 'status'> | undefined;
    if (pRow) {
      if (pRow.status === 'completed' || pRow.status === 'failed' || pRow.status === 'canceled') {
        return false;
      }
      db.prepare(
        `UPDATE polish_tasks SET status='canceled', completed_at=? WHERE id=?`,
      ).run(Date.now(), taskId);
      this.findSlot(taskId)?.abort.abort();
      logEvent({ level: 'info', event: 'polish_canceled', taskId });
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
      this.findSlot(taskId)?.abort.abort();
      logEvent({ level: 'info', event: 'insight_canceled', taskId });
      return true;
    }
    return false;
  }

  /**
   * Cancel every queued/running translate + polish task for a video
   * whose transcription failed or was canceled (P6 partial-failure
   * semantics). Nothing was persisted — partial LLM output only ever
   * lived on the slot's doneCues — and ensureTask/ensurePolishTask
   * resurrection re-runs from scratch once the source is retried;
   * already-persisted chunks make that re-run catch up fast.
   */
  cancelTasksForSource(videoSha: string, reason = 'source-failed'): void {
    const db = getDb();
    const translateIds = db
      .prepare(`SELECT id FROM translate_tasks WHERE video_sha = ? AND status IN ('queued','running')`)
      .all(videoSha) as { id: string }[];
    const polishIds = db
      .prepare(`SELECT id FROM polish_tasks WHERE video_sha = ? AND status IN ('queued','running')`)
      .all(videoSha) as { id: string }[];
    if (translateIds.length + polishIds.length === 0) return;
    for (const row of [...translateIds, ...polishIds]) this.cancel(row.id);
    logEvent({
      level: 'info',
      event: 'llm_source_cancel',
      videoSha,
      reason,
      tasks: translateIds.length + polishIds.length,
    });
  }

  async tryStartNext(): Promise<void> {
    if (this.pauseDepth > 0) return;
    while (this.pauseDepth === 0 && this.activeSlots.length < this.maxActiveSlots()) {
      // Insights start whenever a slot is free (FIFO against same-priority
      // translate/polish — a queued insight is never leap-frogged by tasks
      // created after it), but never two at once: `excludeInsight` is only
      // true while an insight already holds a slot, so the remaining slot
      // keeps serving translate/polish batches during a long summary.
      const next = pickNextLlmTask(this.hasInsightSlot(), pipelineReadyShas());
      if (!next) return;
      // P5 prewarm, relocated for the pipelined era: dispatching a task
      // whose source is still transcribing is the last chance to hide the
      // llama-server cold start behind real work — its first chat lands
      // within one batch. Fire-and-forget: warmup failure must not block
      // dispatch (the chat itself retries the spawn).
      if (next.kind !== 'insight' && !this.prewarmed.has(next.id)) {
        this.prewarmed.add(next.id);
        if (!existsSync(join(SUBCAST_PATHS.cache, next.video_sha, 'original.vtt'))) {
          void getLlmServer().ensure().then(
            () => {},
            () => {},
          );
        }
      }

      if (next.kind === 'translate') {
        await this.startTranslate(next.id);
      } else if (next.kind === 'polish') {
        await this.startPolish(next.id);
      } else {
        await this.startInsight(next.id);
      }
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
    this.activeSlots.push(activeSlot);
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
        `SELECT id, video_sha, model, ui_language, invocation_spec_json
         FROM insight_tasks WHERE id = ?`,
      )
      .get(taskId) as {
        id: string;
        video_sha: string;
        model: LlmModelId;
        ui_language: 'zh-CN' | 'en';
        invocation_spec_json: string | null;
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
    const policyFields = policyFieldsFromSpecJson(row.invocation_spec_json, 'insight');
    const artifactFingerprint = buildInsightArtifactFingerprint({
      videoSha: row.video_sha,
      transcript,
      uiLanguage: row.ui_language,
      modelId: row.model,
      ...policyFields,
    });

    db.prepare(`UPDATE insight_tasks SET status='running' WHERE id=?`).run(taskId);
    const activeSlot: ActiveLLMTask = {
      taskId,
      kind: 'insight',
      videoSha: row.video_sha,
      model: row.model,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      donePromise: Promise.resolve(),
    };
    this.activeSlots.push(activeSlot);
    this.queueEvents.emit('active-changed');
    const params: InsightWorkerParams = {
      videoSha: row.video_sha,
      model: row.model,
      uiLanguage: row.ui_language,
      transcriptVtt: transcript,
      messages,
      cues,
      artifactFingerprint,
    };
    // IIFE owns the queue lifecycle (emit 'end', release the slot, nudge
    // next) so runInsightWorker stays decoupled from LLMQueue internals.
    // The slot is captured in a local — reading it back off the queue
    // would race against other tasks claiming/releasing slots (this IIFE
    // runs after several awaits, so "the queue's slot" may be a different
    // task's by then). Translate's equivalent lives inside
    // runTranslateWorker because that worker pre-dates the LLMQueue split
    // and was moved wholesale.
    const wp = (async () => {
      try {
        await runInsightWorker(activeSlot, params);
      } finally {
        activeSlot.emitter.emit('end');
        this.releaseSlot(activeSlot.taskId);
        this.tryStartNext().catch((err) => {
          logEvent({
            level: 'error',
            event: 'llm_trystartnext_failed',
            msg: err instanceof Error ? err.message : String(err),
          });
        });
      }
    })();
    activeSlot.donePromise = wp.catch(() => {});
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
   * Block until the task occupies a queue slot, the task row's
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
      if (this.findSlot(taskId)) return 'active';
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
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);

    try {
      const origPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');
      let out: Cue[];
      if (existsSync(origPath)) {
        out = await this.translateBatched(active, origPath);
      } else {
        // Pipelined (P6): no original.vtt yet, but a live transcription
        // can feed us cues from the chunks table as they land.
        const live = runningTranscribeTask(videoSha);
        if (!live) throw new Error('ORIGINAL_NOT_READY');
        out = await this.translatePipelined(active, live.id);
      }

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
        const userMsg = userVisibleLlmErrorMessage(code, msg);
        db.prepare(`UPDATE translate_tasks SET status='failed', error_msg=?, error_code=? WHERE id=?`)
          .run(userMsg, code, taskId);
        emit({ event: 'error', data: { taskId, code, msg: userMsg } });
      }
      logEvent({ level: 'error', event: 'translate_failed', taskId, lang, code, msg });
    } finally {
      active.emitter.emit('end');
      this.releaseSlot(active.taskId);
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

  /** Pre-P6 batch mode: whole original.vtt, one translateAll pass. */
  private async translateBatched(active: ActiveLLMTask, origPath: string): Promise<Cue[]> {
    const taskId = active.taskId;
    const lang = active.lang!;
    const model = active.model!;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
    const origCues = parseVtt(readFileSync(origPath, 'utf8'));
    // Must match translateAll's super-batch size — the initial 'status'
    // frame's totalBatches has to agree with the batch-progress frames
    // the worker emits later, or the player's progress bar jumps.
    const totalBatches = Math.max(1, Math.ceil(origCues.length / SUPER_BATCH_SIZE));

    emit({
      event: 'status',
      data: { taskId, status: 'running', model, lang, fromCache: false, totalBatches },
    });

    return translateAll(origCues, lang, {
      modelId: isLlmModelId(model) ? model : undefined,
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
  }

  /**
   * Pipelined translate (P6): consume cues from the live transcription's
   * chunks as they land, firing one super-batch per SUPER_BATCH_SIZE
   * cues; only when original.vtt appears (the source's final cue list is
   * frozen) is the trailing partial batch allowed. Progress is estimated
   * from the transcription's chunk ratio — the final cue count is
   * unknown until the source completes — and clamped monotonic; the
   * player only renders progressPct.
   */
  private async translatePipelined(
    active: ActiveLLMTask,
    sourceTaskId: string,
  ): Promise<Cue[]> {
    const taskId = active.taskId;
    const videoSha = active.videoSha;
    const lang = active.lang!;
    const model = active.model!;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
    const origPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');

    emit({
      event: 'status',
      data: { taskId, status: 'running', model, lang, fromCache: false },
    });

    const context: { src: string; tr: string }[] = [];
    const out: Cue[] = [];
    let emittedPct = 0;
    let batchIdx = 0;
    // Incremental poll cursor — see pollTranscriptSource. Fresh state per
    // worker run; a restarted worker replays the full list on tick one.
    const pollState: TranscriptSourcePollState = { lastChunkIdx: -1, doneChunks: 0, cues: [] };

    const emitProgress = (snap: TranscriptSourceSnapshot) => {
      // Estimated final cue count from the transcription's chunk ratio;
      // monotonic (never re-lowers on re-estimate) and capped at 99
      // until the real total is known at finalization.
      const estTotal =
        snap.doneChunks > 0 && snap.totalChunks > snap.doneChunks
          ? (snap.cues.length / snap.doneChunks) * snap.totalChunks
          : snap.cues.length + SUPER_BATCH_SIZE;
      const pct = Math.min(
        99,
        Math.floor((out.length / Math.max(estTotal, out.length + 1)) * 100),
      );
      if (pct > emittedPct) {
        emittedPct = pct;
        emit({
          event: 'batch-progress',
          data: { taskId, doneBatches: batchIdx, progressPct: pct },
        });
        db.prepare(`UPDATE translate_tasks SET progress_pct = ? WHERE id = ?`).run(
          pct,
          taskId,
        );
      }
    };

    while (true) {
      if (active.abort.signal.aborted) throw new Error('CANCELED');
      const snap = pollTranscriptSource(sourceTaskId, pollState);
      const vttReady = existsSync(origPath);
      if (!snap.live && !vttReady) {
        // Source died without producing original.vtt —
        // cancelTasksForSource normally aborts us first; if we win the
        // race, self-cancel so the row lands in the canceled state.
        active.abort.abort();
        throw new Error('CANCELED');
      }
      // Waiting on a live source = pending work: keep llama-server warm
      // across gaps between super-batches (idle unload would otherwise
      // cost a cold reload on sparse-audio videos).
      if (snap.live) getLlmServer().touch();
      // Fire only complete super-batches while the source is live; the
      // trailing partial batch waits for the frozen final cue list.
      const readyEnd = vttReady
        ? snap.cues.length
        : Math.floor(snap.cues.length / SUPER_BATCH_SIZE) * SUPER_BATCH_SIZE;
      while (out.length < readyEnd) {
        const batch = snap.cues.slice(out.length, out.length + SUPER_BATCH_SIZE);
        const res = await translateSuperBatch(batch, lang, context.slice(-5), {
          batchIdx,
          modelId: isLlmModelId(model) ? model : undefined,
          signal: active.abort.signal,
          onRetry: (attempt) => {
            emit({
              event: 'batch-retry',
              data: { taskId, batchIdx, attempt, reason: 'count-mismatch' },
            });
          },
        });
        active.doneCues!.push(...res.cues);
        out.push(...res.cues);
        context.push(...res.contextPairs);
        emit({
          event: 'cue-translated',
          data: {
            taskId,
            batchIdx,
            cues: res.cues.map((c) => ({
              startMs: c.startMs,
              endMs: c.endMs,
              text: c.text,
            })),
          },
        });
        batchIdx++;
        emitProgress(snap);
      }
      if (vttReady && out.length >= snap.cues.length) return out;
      await new Promise((r) => setTimeout(r, PIPELINE_POLL_MS));
    }
  }

  private async startPolish(taskId: string): Promise<void> {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT id, video_sha, model FROM polish_tasks WHERE id = ?`,
      )
      .get(taskId) as { id: string; video_sha: string; model: string };
    db.prepare(`UPDATE polish_tasks SET status='running' WHERE id=?`).run(taskId);
    const activeSlot: ActiveLLMTask = {
      taskId,
      kind: 'polish',
      videoSha: row.video_sha,
      model: row.model,
      emitter: new EventEmitter(),
      abort: new AbortController(),
      doneCues: [],
      donePromise: Promise.resolve(),
    };
    this.activeSlots.push(activeSlot);
    this.queueEvents.emit('active-changed');
    const wp = this.runPolishWorker(activeSlot);
    activeSlot.donePromise = wp.catch(() => {});
    wp.catch((err) => {
      logEvent({
        level: 'error',
        event: 'llm_worker_crashed',
        kind: 'polish',
        taskId,
        msg: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
  }

  private async runPolishWorker(active: ActiveLLMTask): Promise<void> {
    const taskId = active.taskId;
    const videoSha = active.videoSha;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);

    try {
      const origPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');
      let out: Cue[];
      if (existsSync(origPath)) {
        out = await this.polishBatched(active, origPath);
      } else {
        // Pipelined (P6): auto-polish enqueues at transcription START —
        // this is the normal path for fresh videos now.
        const live = runningTranscribeTask(videoSha);
        if (!live) throw new Error('ORIGINAL_NOT_READY');
        out = await this.polishPipelined(active, live.id);
      }

      const cacheDir = join(SUBCAST_PATHS.cache, videoSha);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, `${POLISH_LAYER_LANG}.vtt`), serializeVtt(out), 'utf8');
      db.prepare(
        `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
         VALUES (?, ?, 'polished', ?, ?)
         ON CONFLICT(video_sha, lang) DO UPDATE SET
           cues_count = excluded.cues_count,
           completed_at = excluded.completed_at`,
      ).run(videoSha, POLISH_LAYER_LANG, out.length, Date.now());
      db.prepare(
        `UPDATE polish_tasks SET status='completed', progress_pct=100, completed_at=? WHERE id=?`,
      ).run(Date.now(), taskId);

      emit({ event: 'done', data: { taskId, totalCues: out.length } });
      logEvent({
        level: 'info',
        event: 'polish_completed',
        taskId,
        cues: out.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code: TaskErrorCode | 'CANCELED' =
        msg === 'CANCELED' || active.abort.signal.aborted
          ? 'CANCELED'
          : msg === 'ORIGINAL_NOT_READY'
            ? 'ORIGINAL_NOT_READY'
            : isLlmConfigError(msg)
              ? 'MODEL_NOT_CONFIGURED'
              : 'FATAL_UNKNOWN';
      if (code === 'CANCELED') {
        // status row already 'canceled' by cancel()
        emit({ event: 'status', data: { taskId, status: 'canceled' } });
      } else {
        const userMsg = userVisibleLlmErrorMessage(code, msg);
        db.prepare(`UPDATE polish_tasks SET status='failed', error_msg=?, error_code=? WHERE id=?`)
          .run(userMsg, code, taskId);
        emit({ event: 'error', data: { taskId, code, msg: userMsg } });
      }
      logEvent({ level: 'error', event: 'polish_failed', taskId, code, msg });
    } finally {
      active.emitter.emit('end');
      this.releaseSlot(active.taskId);
      this.tryStartNext().catch((err) => {
        logEvent({
          level: 'error',
          event: 'polish_trystartnext_failed',
          msg: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      });
    }
  }

  /** Pre-P6 batch mode: whole original.vtt, one polishAll pass. */
  private async polishBatched(active: ActiveLLMTask, origPath: string): Promise<Cue[]> {
    const taskId = active.taskId;
    const model = active.model!;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
    const origCues = parseVtt(readFileSync(origPath, 'utf8'));
    const hints = loadSettings().polishHints;
    const totalBatches = Math.max(1, Math.ceil(origCues.length / POLISH_BATCH_SIZE));

    emit({
      event: 'status',
      data: { taskId, status: 'running', model, fromCache: false, totalBatches },
    });

    return polishAll(origCues, {
      modelId: isLlmModelId(model) ? model : undefined,
      hints,
      signal: active.abort.signal,
      onBatchDone: (info) => {
        active.doneCues!.push(...info.cues);
        emit({
          event: 'cue-polished',
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
          data: { taskId, doneBatches: info.batchIdx + 1, totalBatches: info.totalBatches, progressPct: pct },
        });
        db.prepare(`UPDATE polish_tasks SET progress_pct = ? WHERE id = ?`).run(
          pct,
          taskId,
        );
      },
    });
  }

  /**
   * Pipelined polish (P6) — mirror of translatePipelined. Auto-polish
   * now enqueues at transcription start, so this is the default path for
   * fresh videos: cues stream in from the chunks table, one batch fires
   * per POLISH_BATCH_SIZE cues, and the trailing partial batch waits for
   * original.vtt (the frozen final cue list).
   */
  private async polishPipelined(
    active: ActiveLLMTask,
    sourceTaskId: string,
  ): Promise<Cue[]> {
    const taskId = active.taskId;
    const videoSha = active.videoSha;
    const model = active.model!;
    const db = getDb();
    const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
    const origPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');
    const hints = loadSettings().polishHints;

    emit({
      event: 'status',
      data: { taskId, status: 'running', model, fromCache: false },
    });

    const context: { src: string; polished: string }[] = [];
    const out: Cue[] = [];
    let emittedPct = 0;
    let batchIdx = 0;
    // Incremental poll cursor — see pollTranscriptSource.
    const pollState: TranscriptSourcePollState = { lastChunkIdx: -1, doneChunks: 0, cues: [] };

    const emitProgress = (snap: TranscriptSourceSnapshot) => {
      const estTotal =
        snap.doneChunks > 0 && snap.totalChunks > snap.doneChunks
          ? (snap.cues.length / snap.doneChunks) * snap.totalChunks
          : snap.cues.length + POLISH_BATCH_SIZE;
      const pct = Math.min(
        99,
        Math.floor((out.length / Math.max(estTotal, out.length + 1)) * 100),
      );
      if (pct > emittedPct) {
        emittedPct = pct;
        emit({
          event: 'batch-progress',
          data: { taskId, doneBatches: batchIdx, progressPct: pct },
        });
        db.prepare(`UPDATE polish_tasks SET progress_pct = ? WHERE id = ?`).run(
          pct,
          taskId,
        );
      }
    };

    while (true) {
      if (active.abort.signal.aborted) throw new Error('CANCELED');
      const snap = pollTranscriptSource(sourceTaskId, pollState);
      const vttReady = existsSync(origPath);
      if (!snap.live && !vttReady) {
        active.abort.abort();
        throw new Error('CANCELED');
      }
      // Waiting on a live source = pending work: keep llama-server warm
      // (see the translate worker's identical call).
      if (snap.live) getLlmServer().touch();
      const readyEnd = vttReady
        ? snap.cues.length
        : Math.floor(snap.cues.length / POLISH_BATCH_SIZE) * POLISH_BATCH_SIZE;
      while (out.length < readyEnd) {
        const batch = snap.cues.slice(out.length, out.length + POLISH_BATCH_SIZE);
        const res = await polishOneBatch(batch, hints, context.slice(-5), {
          modelId: isLlmModelId(model) ? model : undefined,
          signal: active.abort.signal,
          batchIdx,
        });
        active.doneCues!.push(...res.cues);
        out.push(...res.cues);
        context.push(...res.contextPairs);
        emit({
          event: 'cue-polished',
          data: {
            taskId,
            batchIdx,
            cues: res.cues.map((c) => ({
              startMs: c.startMs,
              endMs: c.endMs,
              text: c.text,
            })),
          },
        });
        batchIdx++;
        emitProgress(snap);
      }
      if (vttReady && out.length >= snap.cues.length) return out;
      await new Promise((r) => setTimeout(r, PIPELINE_POLL_MS));
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
    const pRow = db
      .prepare(`SELECT 1 FROM polish_tasks WHERE id=?`)
      .get(taskId);
    if (pRow) {
      yield* this.attachPolish(taskId);
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
    if (task.status === 'queued' && !this.findSlot(taskId)) {
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

    if (!this.findSlot(taskId)) {
      await this.tryStartNext();
    }
    if (!this.findSlot(taskId)) {
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
    const live = this.findSlot(taskId)!;
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

  /**
   * Attach to a polish task. Mirrors attachTranslate: completed rows
   * replay from `polished.vtt`, missing files self-heal by re-queueing,
   * queued/running rows live-tail the worker emitter.
   */
  private async *attachPolish(taskId: string): AsyncIterable<SseFrame> {
    const db = getDb();
    const task = db
      .prepare(
        `SELECT id, video_sha, status, model, progress_pct, error_msg
         FROM polish_tasks WHERE id = ?`,
      )
      .get(taskId) as PolishTaskSummary | undefined;
    if (!task) {
      yield {
        event: 'error',
        data: { taskId, code: 'TASK_NOT_FOUND', msg: 'polish task missing' },
      };
      return;
    }

    const vttPath = join(SUBCAST_PATHS.cache, task.video_sha, `${POLISH_LAYER_LANG}.vtt`);
    if (task.status === 'completed') {
      if (existsSync(vttPath)) {
        const cues = parseVtt(await readFile(vttPath, 'utf8'));
        yield {
          event: 'status',
          data: { taskId, status: 'running', model: task.model, fromCache: true },
        };
        yield {
          event: 'cue-polished',
          data: {
            taskId,
            batchIdx: 0,
            cues: cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
          },
        };
        yield { event: 'done', data: { taskId, totalCues: cues.length, fromCache: true } };
        return;
      }
      logEvent({
        level: 'warn',
        event: 'result_file_missing_resurrect',
        kind: 'polish',
        taskId,
        expectedPath: vttPath,
      });
      getDb()
        .prepare(
          `UPDATE polish_tasks SET status='queued', progress_pct=0, error_msg=NULL WHERE id=?`,
        )
        .run(taskId);
      yield { event: 'status', data: { taskId, status: 'queued' } };
      await this.tryStartNext();
    }
    if (task.status === 'failed') {
      yield {
        event: 'error',
        data: { taskId, code: 'FATAL_UNKNOWN', msg: task.error_msg ?? 'previous run failed' },
      };
      return;
    }
    if (task.status === 'canceled') {
      yield { event: 'status', data: { taskId, status: 'canceled' } };
      return;
    }

    if (task.status === 'queued' && !this.findSlot(taskId)) {
      yield {
        event: 'status',
        data: { taskId, status: 'queued', model: task.model, fromCache: false },
      };
    }

    if (!this.findSlot(taskId)) {
      await this.tryStartNext();
    }
    if (!this.findSlot(taskId)) {
      const waitAbort = new AbortController();
      const result = await this.waitForSlot(
        taskId,
        () =>
          (
            getDb()
              .prepare(`SELECT status FROM polish_tasks WHERE id=?`)
              .get(taskId) as { status?: string } | undefined
          )?.status,
        waitAbort.signal,
      );
      if (result === 'terminal') {
        const fresh = getDb()
          .prepare(`SELECT status, error_msg FROM polish_tasks WHERE id=?`)
          .get(taskId) as { status: string; error_msg: string | null } | undefined;
        if (fresh?.status === 'completed') {
          yield* this.attachPolish(taskId);
        } else if (fresh?.status === 'canceled') {
          yield { event: 'status', data: { taskId, status: 'canceled' } };
        } else {
          yield {
            event: 'error',
            data: { taskId, code: 'FATAL_UNKNOWN', msg: fresh?.error_msg ?? 'previous run failed' },
          };
        }
        return;
      }
      if (result === 'aborted') return;
    }

    const live = this.findSlot(taskId)!;
    if (task.progress_pct > 0) {
      yield {
        event: 'batch-progress',
        data: { taskId, progressPct: task.progress_pct },
      };
    }
    if (live.doneCues && live.doneCues.length > 0) {
      yield {
        event: 'cue-polished',
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
        `SELECT id, video_sha, status, model, ui_language, error_msg, invocation_spec_json
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
      const origPath = join(SUBCAST_PATHS.cache, task.video_sha, 'original.vtt');
      let path = join(SUBCAST_PATHS.cache, task.video_sha, 'insights.json');
      if (existsSync(origPath)) {
        const transcript = readFileSync(origPath, 'utf-8');
        const policyFields = policyFieldsFromSpecJson(task.invocation_spec_json, 'insight');
        const artifactFingerprint = buildInsightArtifactFingerprint({
          videoSha: task.video_sha,
          transcript,
          uiLanguage: task.ui_language,
          modelId: task.model,
          ...policyFields,
        });
        const artifact = readLatestInsightArtifact(
          task.video_sha,
          task.ui_language,
          artifactFingerprint,
        );
        if (artifact) {
          yield { event: 'done', data: { insights: artifact.payload, fromCache: true } };
          return;
        }
        path = join(
          SUBCAST_PATHS.cache,
          task.video_sha,
          'artifacts',
          'insight',
          `${artifactFingerprint}.json`,
        );
      }
      const legacyPath = join(SUBCAST_PATHS.cache, task.video_sha, 'insights.json');
      if (existsSync(legacyPath)) {
        const obj = JSON.parse(readFileSync(legacyPath, 'utf-8'));
        yield { event: 'done', data: { insights: obj, fromCache: true, legacy: true } };
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
    if (!this.findSlot(taskId)) {
      await this.tryStartNext();
    }
    if (!this.findSlot(taskId)) {
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

    const live = this.findSlot(taskId)!;
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
   * Cancel every currently-running LLM task and wait for the workers to
   * exit. Used by the Electron `before-quit` hook so the DB doesn't carry
   * 'running' rows across launches.
   */
  async cancelActive(): Promise<void> {
    const slots = [...this.activeSlots];
    if (slots.length === 0) return;
    const db = getDb();
    for (const active of slots) {
      const id = active.taskId;
      const kind = active.kind;
      if (kind === 'translate') {
        db.prepare(`UPDATE translate_tasks SET status='canceled' WHERE id=?`).run(id);
      } else if (kind === 'polish') {
        db.prepare(
          `UPDATE polish_tasks SET status='canceled', completed_at=? WHERE id=?`,
        ).run(Date.now(), id);
      } else {
        db.prepare(
          `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`,
        ).run(Date.now(), id);
      }
      active.abort.abort();
      logEvent({ level: 'info', event: 'llm_canceled', kind, taskId: id, reason: 'shutdown' });
    }
    await Promise.all(slots.map((s) => s.donePromise));
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
    const polishCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM polish_tasks WHERE status IN ('queued','running')`)
        .get() as { n: number }
    ).n;
    if (translateCount + insightCount + polishCount === 0) return;
    db.prepare(
      `UPDATE translate_tasks SET status='canceled' WHERE status IN ('queued','running')`,
    ).run();
    db.prepare(
      `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE status IN ('queued','running')`,
    ).run(Date.now());
    db.prepare(
      `UPDATE polish_tasks SET status='canceled', completed_at=? WHERE status IN ('queued','running')`,
    ).run(Date.now());
    const slots = [...this.activeSlots];
    for (const active of slots) active.abort.abort();
    logEvent({
      level: 'info',
      event: 'llm_cancel_all',
      reason,
      translateCount,
      insightCount,
      polishCount,
    });
    await Promise.all(slots.map((s) => s.donePromise));
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
