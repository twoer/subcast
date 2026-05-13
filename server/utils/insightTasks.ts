/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ollamaStreamChat } from './ollama';
import {
  parseInsights,
  snapChapters,
  type Insights,
} from './insights';
import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import type { Cue } from './vtt';

export type TaskStatus = 'running' | 'done' | 'error' | 'canceled';

export interface InsightTaskError {
  code: string;
  message?: string;
}

export interface InsightTask {
  id: string;
  hash: string;
  model: string;
  uiLanguage: 'zh-CN' | 'en';
  status: TaskStatus;
  raw: string;
  result?: Insights;
  error?: InsightTaskError;
  abort: AbortController;
  events: EventEmitter;
}

const TEMPS = [0.3, 0.0] as const;
const TERMINAL_RETENTION_MS = 60_000;
const tasks = new Map<string, InsightTask>();

export function getTaskByHash(hash: string): InsightTask | undefined {
  return tasks.get(hash);
}

export function getTaskById(id: string): InsightTask | undefined {
  for (const t of tasks.values()) {
    if (t.id === id) return t;
  }
  return undefined;
}

export interface StartParams {
  hash: string;
  model: string;
  uiLanguage: 'zh-CN' | 'en';
  prompt: string;
  cues: readonly Cue[];
}

/**
 * Start (or return existing) detached generation for a hash. Generation
 * continues even after all SSE subscribers disconnect — only explicit
 * `abortTask` (or process exit) stops it.
 */
export function startTask(params: StartParams): InsightTask {
  const prev = tasks.get(params.hash);
  if (prev && prev.status === 'running') return prev;
  if (prev) tasks.delete(params.hash);

  const id = randomUUID();
  const events = new EventEmitter();
  events.setMaxListeners(50);

  const task: InsightTask = {
    id,
    hash: params.hash,
    model: params.model,
    uiLanguage: params.uiLanguage,
    status: 'running',
    raw: '',
    abort: new AbortController(),
    events,
  };
  tasks.set(params.hash, task);

  try {
    getDb().prepare(
      `INSERT OR REPLACE INTO insight_tasks (id, video_sha, status, model, ui_language, created_at)
       VALUES (?, ?, 'running', ?, ?, ?)`,
    ).run(id, params.hash, params.model, params.uiLanguage, Date.now());
  } catch (err) {
    logEvent({
      level: 'warn',
      event: 'insight_db_insert_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  void runGeneration(task, params);
  return task;
}

/**
 * Abort a running task by id. Returns true if an abort was issued.
 */
export function abortTask(taskId: string): boolean {
  const task = getTaskById(taskId);
  if (!task || task.status !== 'running') return false;
  task.abort.abort();
  return true;
}

/**
 * Abort every still-running insight task. Used by the Electron
 * `before-quit` hook so we don't leave 'running' rows behind that the
 * next launch would have to triage as zombies.
 */
export function abortAllInsightTasks(): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === 'running') {
      task.abort.abort();
      count++;
    }
  }
  return count;
}

async function runGeneration(task: InsightTask, params: StartParams): Promise<void> {
  const { prompt, cues, hash, model, uiLanguage } = params;
  const db = getDb();
  let attempt = 0;

  while (attempt < TEMPS.length) {
    task.raw = '';
    try {
      for await (const delta of ollamaStreamChat(model, prompt, task.abort.signal, TEMPS[attempt]!)) {
        task.raw += delta;
        if (attempt === 0) task.events.emit('token', delta);
      }

      const parsed = parseInsights(task.raw);
      const snapped: Insights = { ...parsed, chapters: snapChapters(parsed.chapters, cues) };

      const dir = join(SUBCAST_PATHS.cache, hash);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'insights.json'),
        JSON.stringify(
          {
            ...snapped,
            _meta: {
              ollamaModel: model,
              uiLanguage,
              originalCueCount: cues.length,
              generatedAt: Date.now(),
              rawMarkdown: task.raw,
            },
          },
          null,
          2,
        ),
      );

      db.prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`).run(
        Date.now(),
        task.id,
      );

      task.status = 'done';
      task.result = snapped;
      task.events.emit('done', snapped);
      scheduleEviction(task);
      return;
    } catch (err) {
      attempt++;

      if (task.abort.signal.aborted) {
        db.prepare(`UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`).run(
          Date.now(),
          task.id,
        );
        task.status = 'canceled';
        task.error = { code: 'CANCELED' };
        task.events.emit('error', task.error);
        scheduleEviction(task);
        return;
      }

      if (attempt >= TEMPS.length) {
        const dir = join(SUBCAST_PATHS.cache, hash);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'insights.json.raw.txt'), task.raw);
        } catch (writeErr) {
          logEvent({
            level: 'debug',
            event: 'insights_raw_dump_failed',
            hash,
            taskId: task.id,
            error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        db.prepare(
          `UPDATE insight_tasks SET status='error', error_msg=?, completed_at=? WHERE id=?`,
        ).run(message, Date.now(), task.id);
        task.status = 'error';
        task.error = { code: 'PARSE_FAILED', message };
        task.events.emit('error', task.error);
        scheduleEviction(task);
        return;
      }
    }
  }
}

function scheduleEviction(task: InsightTask): void {
  const timer = setTimeout(() => {
    const current = tasks.get(task.hash);
    if (current?.id === task.id) tasks.delete(task.hash);
  }, TERMINAL_RETENTION_MS);
  timer.unref?.();
}
