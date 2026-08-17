/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Subtitle translation pipeline, rebuilt on top of the backend-agnostic
 * `LLMBackend` (see `llmClient.ts`). Replaces the 0.1 Ollama-specific
 * implementation that lived in `ollama.ts`.
 *
 * Strategy is unchanged from 0.1:
 *
 * - Slide through the cue list in 25-cue super-batches.
 * - Attempt 1: full super-batch in one chat call.
 * - Attempt 2 (on count-mismatch): split into 15-cue sub-batches.
 * - Attempt 3 (per-sub-batch on still-mismatch): per-cue, one call each.
 * - If a per-cue attempt still fails → fall back to the source text.
 *
 * Maintains a small rolling context window of the last 5 translated pairs
 * so tone/terms stay consistent across batches.
 */

import { llmBackend, type LLMChatResult, type LLMMessage } from './llmClient';
import { logEvent } from './log';
import type { Cue } from './vtt';

const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'en-US': 'English',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'fr-FR': 'French',
  'de-DE': 'German',
  'es-ES': 'Spanish',
};

export function langDisplayName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

export function parseJsonArray(raw: string): string[] | null {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  }
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open < 0 || close <= open) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(s.slice(open, close + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  if (!arr.every((x): x is string => typeof x === 'string')) return null;
  return arr;
}

function buildMessages(
  targetLang: string,
  batch: readonly Cue[],
  context: ReadonlyArray<{ src: string; tr: string }>,
): LLMMessage[] {
  const system = [
    `You are a professional subtitle translator. Translate the input subtitles from English (or the source language) into ${langDisplayName(targetLang)}.`,
    '',
    'OUTPUT RULES:',
    '1. Output ONLY a JSON array of strings — same order, same length as the input list.',
    '2. No prose, no numbering, no code fences, no explanation. JUST the JSON array.',
    '3. Keep each translation concise — these are subtitles, not paragraphs.',
    '4. Preserve bracketed labels exactly (e.g. [Music], [Applause]).',
  ].join('\n');

  const userLines: string[] = [];
  if (context.length > 0) {
    userLines.push(
      'CONTEXT — recently translated lines, for tone/term consistency. Do NOT include in output:',
    );
    for (const c of context) {
      userLines.push(`  src: ${c.src}`);
      userLines.push(`  tgt: ${c.tr}`);
    }
    userLines.push('');
  }
  userLines.push(
    `INPUT (${batch.length} subtitle${batch.length === 1 ? '' : 's'} to translate):`,
  );
  for (let i = 0; i < batch.length; i++) {
    userLines.push(`${i + 1}. ${batch[i]!.text.trim()}`);
  }
  userLines.push('');
  userLines.push(`OUTPUT (JSON array of exactly ${batch.length} strings):`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ];
}

interface BatchAttemptResult {
  ok: boolean;
  items: string[];
  parseOk: boolean;
  expectedCount: number;
  actualCount: number | null;
  metrics: LlmResultMetrics;
}

interface LlmResultMetrics {
  finishReason: string | null;
  retries: number;
  coldStart: boolean | null;
  promptTokens: number | null;
  completionTokens: number | null;
  prefillMs: number | null;
  decodeMs: number | null;
  totalMs: number;
}

function llmMetrics(result: LLMChatResult): LlmResultMetrics {
  return {
    finishReason: result.finishReason ?? null,
    retries: result.retries,
    coldStart: result.coldStart ?? null,
    promptTokens: result.usage.promptTokens ?? null,
    completionTokens: result.usage.completionTokens ?? null,
    prefillMs: result.timing.prefillMs ?? null,
    decodeMs: result.timing.decodeMs ?? null,
    totalMs: result.timing.totalMs,
  };
}

async function tryBatch(
  cues: readonly Cue[],
  targetLang: string,
  context: ReadonlyArray<{ src: string; tr: string }>,
  signal?: AbortSignal,
): Promise<BatchAttemptResult> {
  const messages = buildMessages(targetLang, cues, context);
  const result = await llmBackend().chat({
    messages,
    temperature: 0,
    responseSchema: jsonStringArraySchema(cues.length),
    signal,
  });
  const parsed = parseJsonArray(result.content);
  const expectedCount = cues.length;
  const actualCount = parsed?.length ?? null;
  return {
    ok: parsed !== null && parsed.length === expectedCount,
    items: parsed ?? [],
    parseOk: parsed !== null,
    expectedCount,
    actualCount,
    metrics: llmMetrics(result),
  };
}

export interface TranslateAllOptions {
  signal?: AbortSignal;
  onSuperBatchStart?: (info: {
    batchIdx: number;
    totalBatches: number;
    cueCount: number;
  }) => void;
  onSuperBatchDone?: (info: {
    batchIdx: number;
    totalBatches: number;
    cues: Cue[];
  }) => void;
  onBatchRetry?: (info: {
    batchIdx: number;
    attempt: 1 | 2;
    reason: 'count-mismatch' | 'parse-fail';
  }) => void;
}

export const SUPER_BATCH_SIZE = 25;
const SUB_BATCH_SIZE = 15;

/**
 * Grammar constraint for the "exactly N strings" contract. minItems/
 * maxItems enforcement depends on llama.cpp's schema→grammar version;
 * the array-of-strings structure itself is always enforced, and the
 * count check in the caller stays as the safety net either way.
 */
export function jsonStringArraySchema(count: number): Record<string, unknown> {
  return {
    type: 'array',
    items: { type: 'string' },
    minItems: count,
    maxItems: count,
  };
}

export interface TranslateBatchResult {
  cues: Cue[];
  /** src/tr pairs to append to the caller's rolling context window. */
  contextPairs: { src: string; tr: string }[];
  /** Number of cues that kept their source text after the full ladder. */
  fallbackCount: number;
}

export interface TranslateBatchOptions {
  /** Only feeds logEvent fields — no behavioral meaning. */
  batchIdx?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: 1 | 2) => void;
}

/**
 * Translate exactly one super-batch (≤ SUPER_BATCH_SIZE cues) through the
 * full retry ladder (25 → 15 sub-batches → per-cue → source-text
 * fallback). Self-contained: pass the last-5 context pairs in, append the
 * returned `contextPairs` to the rolling window — this is the unit the
 * pipelined worker calls as transcription produces cues, so it must not
 * assume anything about the surrounding loop.
 */
export async function translateSuperBatch(
  superBatch: readonly Cue[],
  targetLang: string,
  ctx: ReadonlyArray<{ src: string; tr: string }>,
  opts: TranslateBatchOptions = {},
): Promise<TranslateBatchResult> {
  const batchIdx = opts.batchIdx ?? 0;
  const contextPairs: { src: string; tr: string }[] = [];
  const segCues: Cue[] = [];
  let fallbackCount = 0;

  const out1 = await tryBatch(superBatch, targetLang, ctx, opts.signal);
  if (out1.ok) {
    for (let i = 0; i < superBatch.length; i++) {
      segCues.push({
        startMs: superBatch[i]!.startMs,
        endMs: superBatch[i]!.endMs,
        text: out1.items[i]!,
      });
      contextPairs.push({ src: superBatch[i]!.text.trim(), tr: out1.items[i]!.trim() });
    }
    return { cues: segCues, contextPairs, fallbackCount };
  }

  // Attempt 1 failed; degrade to sub-batches.
  opts.onRetry?.(1);
  logEvent({
    level: 'warn',
    event: 'translate_count_mismatch',
    batchIdx,
    attempt: 1,
    targetLang,
    expectedCount: out1.expectedCount,
    actualCount: out1.actualCount,
    parseOk: out1.parseOk,
    ...out1.metrics,
  });

  let degraded = false;
  for (let j = 0; j < superBatch.length; j += SUB_BATCH_SIZE) {
    if (opts.signal?.aborted) throw new Error('CANCELED');
    const sub = superBatch.slice(j, j + SUB_BATCH_SIZE);
    const out2 = await tryBatch(sub, targetLang, ctx, opts.signal);
    if (out2.ok) {
      for (let i = 0; i < sub.length; i++) {
        segCues.push({
          startMs: sub[i]!.startMs,
          endMs: sub[i]!.endMs,
          text: out2.items[i]!,
        });
        contextPairs.push({ src: sub[i]!.text.trim(), tr: out2.items[i]!.trim() });
      }
      continue;
    }

    // Attempt 2 on this sub-batch failed; degrade to per-cue.
    if (!degraded) {
      opts.onRetry?.(2);
      degraded = true;
    }
    logEvent({
      level: 'warn',
      event: 'translate_count_mismatch',
      batchIdx,
      attempt: 2,
      targetLang,
      subStart: j,
      expectedCount: out2.expectedCount,
      actualCount: out2.actualCount,
      parseOk: out2.parseOk,
      ...out2.metrics,
    });
    for (const cue of sub) {
      if (opts.signal?.aborted) throw new Error('CANCELED');
      const single = await tryBatch([cue], targetLang, ctx, opts.signal);
      if (!single.ok) {
        fallbackCount++;
        logEvent({
          level: 'warn',
          event: 'translate_cue_fallback',
          batchIdx,
          targetLang,
          cueStartMs: cue.startMs,
          parseOk: single.parseOk,
          actualCount: single.actualCount,
          ...single.metrics,
        });
        segCues.push({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text });
        contextPairs.push({ src: cue.text.trim(), tr: cue.text.trim() });
        continue;
      }
      segCues.push({ startMs: cue.startMs, endMs: cue.endMs, text: single.items[0]! });
      contextPairs.push({ src: cue.text.trim(), tr: single.items[0]!.trim() });
    }
  }
  return { cues: segCues, contextPairs, fallbackCount };
}

export async function translateAll(
  cues: readonly Cue[],
  targetLang: string,
  opts: TranslateAllOptions = {},
): Promise<Cue[]> {
  const totalBatches = Math.max(1, Math.ceil(cues.length / SUPER_BATCH_SIZE));
  const context: { src: string; tr: string }[] = [];
  const out: Cue[] = [];
  let fallbackCount = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    if (opts.signal?.aborted) throw new Error('CANCELED');
    const start = batchIdx * SUPER_BATCH_SIZE;
    const end = Math.min(start + SUPER_BATCH_SIZE, cues.length);
    const superBatch = cues.slice(start, end);
    opts.onSuperBatchStart?.({ batchIdx, totalBatches, cueCount: superBatch.length });

    const res = await translateSuperBatch(superBatch, targetLang, context.slice(-5), {
      batchIdx,
      signal: opts.signal,
      onRetry: (attempt) => opts.onBatchRetry?.({ batchIdx, attempt, reason: 'count-mismatch' }),
    });
    out.push(...res.cues);
    context.push(...res.contextPairs);
    fallbackCount += res.fallbackCount;

    opts.onSuperBatchDone?.({ batchIdx, totalBatches, cues: res.cues });
  }

  logEvent({
    level: fallbackCount > 0 ? 'warn' : 'debug',
    event: 'translate_fallback_summary',
    targetLang,
    fallbackCount,
    totalCues: out.length,
  });
  return out;
}
