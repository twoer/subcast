/* SPDX-License-Identifier: Apache-2.0 */

/**
 * AI transcript polish — an LLM post-pass over the raw ASR transcript.
 *
 * Small ASR models (SenseVoice) produce three systematic error classes
 * the local LLM is good at fixing from context:
 *   1. Homophone/near-homophone substitutions (布尔 → misheard as 球叉)
 *   2. Embedded foreign tokens transliterated (AI → "a i", 3D → "三 d")
 *   3. Missing punctuation
 *
 * Contract mirrors translate.ts: slide through cues in batches, demand a
 * strict JSON array of strings with the exact same length, degrade to a
 * smaller batch once, and fall back to the ORIGINAL cue text when the
 * model still can't comply. Fallback (not retry-forever) is the safety
 * valve against over-correction: an unfixable cue keeps its original
 * text rather than a hallucination. Cue count and timestamps are
 * therefore invariant — the polished layer stays 1:1 alignable with
 * original.vtt for bilingual export and the player's variant toggle.
 *
 * `hints` (settings.polishHints) carries user-supplied domain terms
 * (names, places, jargon) — empirically the biggest quality lever for
 * proper-noun correction.
 */

import { llmBackend, type LLMMessage } from './llmClient';
import { logEvent } from './log';
import { jsonStringArraySchema, parseJsonArray } from './translate';
import type { Cue } from './vtt';

export const BATCH_SIZE = 25;
const RETRY_BATCH_SIZE = 10;
const RAW_PREVIEW_CHARS = 160;

export function buildPolishMessages(
  batch: readonly Cue[],
  hints: string,
  context: ReadonlyArray<{ src: string; polished: string }>,
): LLMMessage[] {
  const system = [
    '你是字幕校对编辑。输入是语音识别生成的原始字幕，存在三类典型错误：',
    '1. 同音/近音错字：地名、人名、术语被写成发音相近的其他词',
    '2. 英文被拆散或音译：如 "a i" 应为 "AI"，"三 d" 应为 "3D"',
    '3. 标点缺失',
    '',
    '修正规则：',
    '- 根据上下文推断并修正错别字；英文按惯例书写（AI、3D 等）；为本条字幕补全标点',
    '- 只改写文本本身：严禁增删语义内容、合并拆分条目、改写句式',
    '- 无法确定本意时，保留该条原文（宁可少改，不可改错）',
    '',
    'OUTPUT RULES:',
    '1. Output ONLY a JSON array of strings — same order, same length as the input list.',
    '2. No prose, no numbering, no code fences, no explanation. JUST the JSON array.',
  ].join('\n');

  const userLines: string[] = [];
  if (hints.trim()) {
    userLines.push('专有名词提示（优先按这些写法修正）：');
    for (const term of hints.split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean)) {
      userLines.push(`  ${term}`);
    }
    userLines.push('');
  }
  if (context.length > 0) {
    userLines.push('CONTEXT — recently polished lines, for term consistency. Do NOT include in output:');
    for (const c of context) {
      userLines.push(`  src: ${c.src}`);
      userLines.push(`  out: ${c.polished}`);
    }
    userLines.push('');
  }
  userLines.push(`INPUT (${batch.length} 条字幕待修正):`);
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

function previewRaw(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, RAW_PREVIEW_CHARS);
}

async function tryPolishBatch(
  batch: readonly Cue[],
  hints: string,
  context: ReadonlyArray<{ src: string; polished: string }>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; items: string[]; rawPreview: string }> {
  const raw = await llmBackend().chat({
    messages: buildPolishMessages(batch, hints, context),
    temperature: 0,
    responseSchema: jsonStringArraySchema(batch.length),
    signal,
  });
  const parsed = parseJsonArray(raw);
  return {
    ok: parsed !== null && parsed.length === batch.length,
    items: parsed ?? [],
    rawPreview: previewRaw(raw),
  };
}

export interface PolishAllOptions {
  hints?: string;
  signal?: AbortSignal;
  onBatchDone?: (info: { batchIdx: number; totalBatches: number; cues: Cue[] }) => void;
}

export interface PolishBatchResult {
  cues: Cue[];
  /** src/polished pairs to append to the caller's rolling context window. */
  contextPairs: { src: string; polished: string }[];
  /** True when the whole batch fell back to original text. */
  fallback: boolean;
}

/**
 * Polish exactly one batch (≤ BATCH_SIZE cues) through the 25→10 retry
 * ladder with whole-batch fallback. Self-contained counterpart of
 * translate.ts's `translateSuperBatch` — the pipelined worker calls this
 * per batch as transcription produces cues, so it must not assume
 * anything about the surrounding loop.
 */
export async function polishOneBatch(
  batch: readonly Cue[],
  hints: string,
  ctx: ReadonlyArray<{ src: string; polished: string }>,
  signal?: AbortSignal,
  batchIdx = 0,
): Promise<PolishBatchResult> {
  let items: string[] | null = null;
  const attempt1 = await tryPolishBatch(batch, hints, ctx, signal);
  if (attempt1.ok) {
    items = attempt1.items;
  } else {
    logEvent({
      level: 'warn',
      event: 'polish_batch_mismatch',
      batchIdx,
      attempt: 1,
      expectedCount: batch.length,
      rawPreview: attempt1.rawPreview,
    });
    // One retry on smaller batches — a long batch occasionally trips
    // the count contract; a short one rarely does.
    const segCues: string[] = [];
    let allOk = true;
    for (let j = 0; j < batch.length && allOk; j += RETRY_BATCH_SIZE) {
      const sub = batch.slice(j, j + RETRY_BATCH_SIZE);
      const attempt2 = await tryPolishBatch(sub, hints, ctx, signal);
      if (!attempt2.ok) {
        allOk = false;
        logEvent({
          level: 'warn',
          event: 'polish_batch_mismatch',
          batchIdx,
          attempt: 2,
          expectedCount: sub.length,
          rawPreview: attempt2.rawPreview,
        });
        break;
      }
      segCues.push(...attempt2.items);
    }
    if (allOk) items = segCues;
  }

  const segOut: Cue[] = [];
  let fallback = false;
  if (items === null) {
    // Fallback: keep original text for this batch. Polish is an
    // enhancement layer — a batch we can't safely rewrite stays
    // verbatim instead of blocking the whole layer.
    fallback = true;
    for (const cue of batch) {
      segOut.push({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text });
    }
  } else {
    for (let i = 0; i < batch.length; i++) {
      segOut.push({
        startMs: batch[i]!.startMs,
        endMs: batch[i]!.endMs,
        text: items[i]!.trim() || batch[i]!.text,
      });
    }
  }
  const contextPairs = segOut.map((c, i) => ({
    src: batch[i]!.text.trim(),
    polished: c.text.trim(),
  }));
  return { cues: segOut, contextPairs, fallback };
}

export async function polishAll(
  cues: readonly Cue[],
  opts: PolishAllOptions = {},
): Promise<Cue[]> {
  const hints = opts.hints ?? '';
  const totalBatches = Math.max(1, Math.ceil(cues.length / BATCH_SIZE));
  const context: { src: string; polished: string }[] = [];
  const out: Cue[] = [];
  let fallbackCount = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    if (opts.signal?.aborted) throw new Error('CANCELED');
    const start = batchIdx * BATCH_SIZE;
    const batch = cues.slice(start, start + BATCH_SIZE);

    const res = await polishOneBatch(batch, hints, context.slice(-5), opts.signal, batchIdx);
    out.push(...res.cues);
    context.push(...res.contextPairs);
    if (res.fallback) fallbackCount++;

    opts.onBatchDone?.({ batchIdx, totalBatches, cues: res.cues });
  }

  logEvent({
    level: fallbackCount > 0 ? 'warn' : 'debug',
    event: 'polish_fallback_summary',
    fallbackCount,
    totalCues: out.length,
  });
  return out;
}
