/* SPDX-License-Identifier: Apache-2.0 */
import { llmBackend } from './llmClient';
import type { LLMMessage } from './llmClient';
import {
  parseInsights,
  snapChapters,
  type Insights,
} from './insights';
import { planInsightContext, type InsightContextPlan } from './contextBudget';
import {
  PARTIAL_INSIGHT_SCHEMA,
  buildInsightMapMessages,
  buildInsightReduceMessages,
  finalizeReducedInsightMarkdown,
  parsePartialInsight,
  type PartialInsight,
} from './insightReduce';
import { getDb } from './db';
import { logEvent } from './log';
import { writeInsightArtifact } from './artifactStore';
import type { Cue } from './vtt';
import type { QueueActiveLLMTask as ActiveLLMTask } from './queueTypes';
import type { SseFrame } from './sse';
import { isLlmConfigError } from '#shared/errorCodes';
import type { LlmModelId } from '#shared/llmModels';

export const TEMPS = [0.3, 0.0] as const;

export interface InsightWorkerParams {
  videoSha: string;
  model: LlmModelId;
  uiLanguage: 'zh-CN' | 'en';
  transcriptVtt: string;
  messages: LLMMessage[];
  cues: readonly Cue[];
  artifactFingerprint: string;
}

export async function runInsightWorker(
  active: ActiveLLMTask,
  params: InsightWorkerParams,
): Promise<void> {
  const { messages, cues, videoSha, model, uiLanguage, transcriptVtt, artifactFingerprint } = params;
  const db = getDb();
  const taskId = active.taskId;
  const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
  let attempt = 0;
  const contextPlan = planInsightContext(transcriptVtt);

  while (attempt < TEMPS.length) {
    active.insightRaw = '';
    try {
      const snapped = contextPlan.mode === 'single'
        ? await runSinglePassInsight({
            active,
            emit,
            messages,
            cues,
            temperature: TEMPS[attempt]!,
            streamTokens: attempt === 0,
          })
        : await runMapReduceInsight({
            active,
            emit,
            contextPlan,
            uiLanguage,
            cues,
            temperature: TEMPS[attempt]!,
          });

      const payload = {
        ...snapped,
        _meta: {
          modelId: model,
          uiLanguage,
          originalCueCount: cues.length,
          artifactFingerprint,
          generatedAt: Date.now(),
        },
      };
      writeInsightArtifact(videoSha, uiLanguage, artifactFingerprint, payload);

      db.prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`)
        .run(Date.now(), taskId);
      emit({ event: 'done', data: { insights: payload, fromCache: false } });
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
      // Configuration errors won't recover by retrying with a different
      // temperature — short-circuit with a specific code so the UI can
      // direct the user to Settings instead of saying "AI output couldn't
      // be parsed, retry."
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isLlmConfigError(errMsg)) {
        db.prepare(
          `UPDATE insight_tasks SET status='error', error_msg=?, error_code='MODEL_NOT_CONFIGURED', completed_at=? WHERE id=?`,
        ).run(errMsg, Date.now(), taskId);
        emit({ event: 'error', data: { code: 'MODEL_NOT_CONFIGURED', message: errMsg } });
        return;
      }
      if (attempt >= TEMPS.length) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent({
          level: 'warn',
          event: 'insights_parse_failed',
          videoSha,
          taskId,
          attemptCount: attempt,
          outputChars: active.insightRaw?.length ?? 0,
          errorClass: err instanceof Error ? err.name : typeof err,
        });
        db.prepare(
          `UPDATE insight_tasks SET status='error', error_msg=?, error_code='PARSE_FAILED', completed_at=? WHERE id=?`,
        ).run(message, Date.now(), taskId);
        emit({ event: 'error', data: { code: 'PARSE_FAILED', message } });
        return;
      }
    }
  }
}

async function runSinglePassInsight(input: {
  active: ActiveLLMTask;
  emit: (frame: SseFrame) => void;
  messages: LLMMessage[];
  cues: readonly Cue[];
  temperature: number;
  streamTokens: boolean;
}): Promise<Insights> {
  const backend = llmBackend();
  let raw = '';
  const stream = backend.chatStream({
    messages: input.messages,
    temperature: input.temperature,
    maxTokens: 4096,
    signal: input.active.abort.signal,
  });
  for await (const chunk of stream) {
    if (chunk.delta) {
      raw += chunk.delta;
      if (input.streamTokens) {
        input.active.insightRaw = raw;
        input.emit({ event: 'token', data: { text: chunk.delta } });
      }
    }
    if (chunk.finishReason === 'cancel') break;
  }

  const parsed = parseInsights(raw);
  return { ...parsed, chapters: snapChapters(parsed.chapters, input.cues) };
}

async function runMapReduceInsight(input: {
  active: ActiveLLMTask;
  emit: (frame: SseFrame) => void;
  contextPlan: InsightContextPlan;
  uiLanguage: 'zh-CN' | 'en';
  cues: readonly Cue[];
  temperature: number;
}): Promise<Insights> {
  const backend = llmBackend();
  const partials: PartialInsight[] = [];
  const totalWindows = input.contextPlan.windows.length;

  input.emit({
    event: 'phase',
    data: { phase: 'map', doneWindows: 0, totalWindows, progressPct: 0 },
  });

  for (const window of input.contextPlan.windows) {
    const result = await backend.chat({
      messages: buildInsightMapMessages({
        transcriptWindow: window.text,
        uiLanguage: input.uiLanguage,
        windowIndex: window.index,
        totalWindows: window.total,
      }),
      temperature: input.temperature,
      maxTokens: window.maxOutputTokens,
      responseSchema: PARTIAL_INSIGHT_SCHEMA,
      signal: input.active.abort.signal,
    });
    partials.push(parsePartialInsight(result.content));
    const doneWindows = window.index + 1;
    input.emit({
      event: 'progress',
      data: {
        phase: 'map',
        doneWindows,
        totalWindows,
        progressPct: Math.round((doneWindows / (totalWindows + 1)) * 90),
      },
    });
  }

  input.emit({
    event: 'phase',
    data: { phase: 'reduce', doneWindows: totalWindows, totalWindows, progressPct: 90 },
  });
  const reduced = await backend.chat({
    messages: buildInsightReduceMessages({ uiLanguage: input.uiLanguage, partials }),
    temperature: input.temperature,
    maxTokens: 4096,
    signal: input.active.abort.signal,
  });
  const insights = finalizeReducedInsightMarkdown(reduced.content, input.cues);
  input.emit({
    event: 'progress',
    data: { phase: 'reduce', doneWindows: totalWindows, totalWindows, progressPct: 100 },
  });
  return insights;
}
