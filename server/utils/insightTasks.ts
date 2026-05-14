/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmBackend } from './llmClient';
import type { LLMMessage } from './llmClient';
import {
  parseInsights,
  snapChapters,
  type Insights,
} from './insights';
import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import type { Cue } from './vtt';
import type { ActiveLLMTask } from './queue';
import type { SseFrame } from './sse';

export type TaskStatus = 'running' | 'done' | 'error' | 'canceled';

export interface InsightTaskError {
  code: string;
  message?: string;
}

export const TEMPS = [0.3, 0.0] as const;

export interface InsightWorkerParams {
  videoSha: string;
  model: string;
  uiLanguage: 'zh-CN' | 'en';
  messages: LLMMessage[];
  cues: readonly Cue[];
}

export async function runInsightWorker(
  active: ActiveLLMTask,
  params: InsightWorkerParams,
): Promise<void> {
  const { messages, cues, videoSha, model, uiLanguage } = params;
  const db = getDb();
  const taskId = active.taskId;
  const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
  let raw = '';
  let attempt = 0;
  const backend = llmBackend();

  while (attempt < TEMPS.length) {
    active.insightRaw = '';
    raw = '';
    try {
      const stream = backend.chatStream({
        messages,
        temperature: TEMPS[attempt]!,
        maxTokens: 4096,
        signal: active.abort.signal,
      });
      for await (const chunk of stream) {
        if (chunk.delta) {
          raw += chunk.delta;
          if (attempt === 0) {
            active.insightRaw = raw;
            emit({ event: 'token', data: { text: chunk.delta } });
          }
        }
        if (chunk.finishReason === 'cancel') break;
      }

      const parsed = parseInsights(raw);
      const snapped: Insights = { ...parsed, chapters: snapChapters(parsed.chapters, cues) };

      const dir = join(SUBCAST_PATHS.cache, videoSha);
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
              rawMarkdown: raw,
            },
          },
          null,
          2,
        ),
      );

      db.prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`)
        .run(Date.now(), taskId);
      emit({ event: 'done', data: { insights: snapped, fromCache: false } });
      return;
    } catch (err) {
      attempt++;
      if (active.abort.signal.aborted) {
        db.prepare(
          `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`,
        ).run(Date.now(), taskId);
        emit({ event: 'error', data: { code: 'CANCELED' } });
        return;
      }
      if (attempt >= TEMPS.length) {
        const dir = join(SUBCAST_PATHS.cache, videoSha);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'insights.json.raw.txt'), raw);
        } catch (writeErr) {
          logEvent({
            level: 'debug',
            event: 'insights_raw_dump_failed',
            videoSha,
            taskId,
            error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        db.prepare(
          `UPDATE insight_tasks SET status='error', error_msg=?, completed_at=? WHERE id=?`,
        ).run(message, Date.now(), taskId);
        emit({ event: 'error', data: { code: 'PARSE_FAILED', message } });
        return;
      }
    }
  }
}

// TODO(slice-7): stub retained for callers not yet migrated (cache/list, cache/delete, transcribe/retry)
export function getTaskByHash(_hash: string): undefined {
  return undefined;
}

// TODO(slice-4): stub retained for insights/[id].delete not yet migrated
export function abortTask(_taskId: string): false {
  return false;
}

// TODO(slice-7): stub retained for desktop/shutdown.post not yet migrated
export function abortAllInsightTasks(): 0 {
  return 0;
}
