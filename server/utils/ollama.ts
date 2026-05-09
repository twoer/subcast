import { logEvent } from './log';
import type { Cue } from './vtt';

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';
export const DEFAULT_TRANSLATE_MODEL =
  process.env.SUBCAST_OLLAMA_MODEL ?? 'qwen2.5:7b';

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

export async function isOllamaReady(
  model: string = DEFAULT_TRANSLATE_MODEL,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { ok: false, reason: `OLLAMA_HTTP_${res.status}` };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const installed = (data.models ?? []).map((m) => m.name);
    const exact = installed.includes(model);
    const family = model.split(':')[0]!;
    const familyMatch = installed.find((n) => n.startsWith(`${family}:`));
    if (!exact && !familyMatch) {
      return {
        ok: false,
        reason: `MODEL_NOT_PULLED: '${model}'. Installed: ${installed.join(', ') || '(none)'}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `OLLAMA_UNREACHABLE: ${msg}` };
  }
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
}

async function ollamaChat(
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0 },
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as OllamaChatResponse;
  return json.message?.content ?? '';
}

function buildPrompt(
  targetLang: string,
  batch: readonly Cue[],
  context: ReadonlyArray<{ src: string; tr: string }>,
): string {
  const lines: string[] = [];
  lines.push(
    `You are a professional subtitle translator. Translate the input subtitles from English (or the source language) into ${langDisplayName(targetLang)}.`,
  );
  lines.push('');
  lines.push('OUTPUT RULES:');
  lines.push('1. Output ONLY a JSON array of strings — same order, same length as the input list.');
  lines.push('2. No prose, no numbering, no code fences, no explanation. JUST the JSON array.');
  lines.push('3. Keep each translation concise — these are subtitles, not paragraphs.');
  lines.push('4. Preserve bracketed labels exactly (e.g. [Music], [Applause]).');
  if (context.length > 0) {
    lines.push('');
    lines.push('CONTEXT — recently translated lines, for tone/term consistency. Do NOT include in output:');
    for (const c of context) {
      lines.push(`  src: ${c.src}`);
      lines.push(`  tgt: ${c.tr}`);
    }
  }
  lines.push('');
  lines.push(`INPUT (${batch.length} subtitle${batch.length === 1 ? '' : 's'} to translate):`);
  for (let i = 0; i < batch.length; i++) {
    lines.push(`${i + 1}. ${batch[i]!.text.trim()}`);
  }
  lines.push('');
  lines.push(`OUTPUT (JSON array of exactly ${batch.length} strings):`);
  return lines.join('\n');
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

async function tryBatch(
  cues: readonly Cue[],
  targetLang: string,
  context: ReadonlyArray<{ src: string; tr: string }>,
  model: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const prompt = buildPrompt(targetLang, cues, context);
  const raw = await ollamaChat(model, prompt, signal);
  const parsed = parseJsonArray(raw);
  if (!parsed) return null;
  if (parsed.length !== cues.length) return null;
  return parsed;
}

export interface TranslateAllOptions {
  model?: string;
  signal?: AbortSignal;
  onSuperBatchStart?: (info: { batchIdx: number; totalBatches: number; cueCount: number }) => void;
  onSuperBatchDone?: (info: { batchIdx: number; totalBatches: number; cues: Cue[] }) => void;
  onBatchRetry?: (info: {
    batchIdx: number;
    attempt: 1 | 2;
    reason: 'count-mismatch' | 'parse-fail';
  }) => void;
}

const SUPER_BATCH_SIZE = 40;
const SUB_BATCH_SIZE = 15;

/**
 * Slide through the cue list in 40-cue super-batches per design §5 B.
 *
 * - Attempt 1: full super-batch in one Ollama call.
 * - Attempt 2 (on count-mismatch): split into 15-cue sub-batches.
 * - Attempt 3 (per-sub-batch on still-mismatch): per-cue, one call each.
 * - If a per-cue attempt still fails → throw BATCH_RETRY_EXHAUSTED.
 *
 * Maintains a small rolling context window of the last 5 translated pairs to
 * keep tone/terms consistent across batches.
 */
export async function translateAll(
  cues: readonly Cue[],
  targetLang: string,
  opts: TranslateAllOptions = {},
): Promise<Cue[]> {
  const model = opts.model ?? DEFAULT_TRANSLATE_MODEL;
  const totalBatches = Math.max(1, Math.ceil(cues.length / SUPER_BATCH_SIZE));
  const context: { src: string; tr: string }[] = [];
  const out: Cue[] = [];

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    if (opts.signal?.aborted) throw new Error('CANCELED');
    const start = batchIdx * SUPER_BATCH_SIZE;
    const end = Math.min(start + SUPER_BATCH_SIZE, cues.length);
    const superBatch = cues.slice(start, end);
    const ctx = context.slice(-5);
    opts.onSuperBatchStart?.({ batchIdx, totalBatches, cueCount: superBatch.length });

    const out1 = await tryBatch(superBatch, targetLang, ctx, model, opts.signal);
    if (out1) {
      const segCues = out1.map<Cue>((text, i) => ({
        startMs: superBatch[i]!.startMs,
        endMs: superBatch[i]!.endMs,
        text,
      }));
      out.push(...segCues);
      for (let i = 0; i < segCues.length; i++) {
        context.push({ src: superBatch[i]!.text.trim(), tr: out1[i]!.trim() });
      }
      opts.onSuperBatchDone?.({ batchIdx, totalBatches, cues: segCues });
      continue;
    }

    // Attempt 1 failed; degrade to sub-batches
    opts.onBatchRetry?.({ batchIdx, attempt: 1, reason: 'count-mismatch' });
    logEvent({
      level: 'warn',
      event: 'translate_count_mismatch',
      batchIdx,
      attempt: 1,
      cueCount: superBatch.length,
    });

    const segCues: Cue[] = [];
    let degraded = false;
    for (let j = 0; j < superBatch.length; j += SUB_BATCH_SIZE) {
      if (opts.signal?.aborted) throw new Error('CANCELED');
      const sub = superBatch.slice(j, j + SUB_BATCH_SIZE);
      const out2 = await tryBatch(sub, targetLang, ctx, model, opts.signal);
      if (out2) {
        for (let i = 0; i < sub.length; i++) {
          segCues.push({ startMs: sub[i]!.startMs, endMs: sub[i]!.endMs, text: out2[i]! });
          context.push({ src: sub[i]!.text.trim(), tr: out2[i]!.trim() });
        }
        continue;
      }

      // Attempt 2 on this sub-batch failed; degrade to per-cue
      if (!degraded) {
        opts.onBatchRetry?.({ batchIdx, attempt: 2, reason: 'count-mismatch' });
        degraded = true;
      }
      logEvent({
        level: 'warn',
        event: 'translate_count_mismatch',
        batchIdx,
        attempt: 2,
        subStart: j,
        subSize: sub.length,
      });
      for (const cue of sub) {
        if (opts.signal?.aborted) throw new Error('CANCELED');
        const single = await tryBatch([cue], targetLang, ctx, model, opts.signal);
        if (!single) {
          logEvent({
            level: 'warn',
            event: 'translate_cue_fallback',
            batchIdx,
            cueStartMs: cue.startMs,
            cueText: cue.text.slice(0, 60),
          });
          segCues.push({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text });
          context.push({ src: cue.text.trim(), tr: cue.text.trim() });
          continue;
        }
        segCues.push({ startMs: cue.startMs, endMs: cue.endMs, text: single[0]! });
        context.push({ src: cue.text.trim(), tr: single[0]!.trim() });
      }
    }
    out.push(...segCues);
    opts.onSuperBatchDone?.({ batchIdx, totalBatches, cues: segCues });
  }

  return out;
}
