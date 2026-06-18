/* SPDX-License-Identifier: Apache-2.0 */
import type { LLMMessage } from './llmClient';
import type { Cue } from './vtt';

export interface Chapter {
  startMs: number;
  title: string;
  description: string;
}

export interface Insights {
  summary: string;
  summaryBullets: string[];
  chapters: Chapter[];
}

const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  'en-US': 'English',
};

/**
 * Build the chat messages used to ask the local LLM for video insights.
 * The system message carries the format contract; the user message carries
 * only the transcript so the model "sees" the data, not the instructions,
 * as the active turn — this works better for the OpenAI-compat chat API
 * that llama-server speaks.
 */
export function buildInsightMessages(transcriptVtt: string, uiLang: string): LLMMessage[] {
  const langName = LANG_NAMES[uiLang] ?? 'English';
  const system = [
    'You are summarizing a video transcript. Output strict markdown following the template below. Do not add any other sections, code fences, or commentary.',
    '',
    `LANGUAGE: All output text MUST be in ${langName}.`,
    '',
    'TEMPLATE:',
    '## Summary',
    '',
    '<one paragraph, 100-300 words, written naturally>',
    '',
    '- <key point 1>',
    '- <key point 2>',
    '- <key point 3>',
    '(3 to 5 bullets total)',
    '',
    '## Chapters',
    '',
    '- [HH:MM:SS] <Chapter title> — <one-sentence description>',
    '- [HH:MM:SS] <Chapter title> — <one-sentence description>',
    '(3 to 8 chapters total; use exact timestamps that appear in the transcript)',
  ].join('\n');
  const user = `TRANSCRIPT:\n\n${transcriptVtt}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * @deprecated Use {@link buildInsightMessages} instead. Retained for callers
 * that still need a single concatenated prompt string (e.g. size-budget
 * heuristics that count characters).
 */
export function buildPrompt(transcriptVtt: string, uiLang: string): string {
  return buildInsightMessages(transcriptVtt, uiLang)
    .map((m) => m.content)
    .join('\n\n');
}

function tsToMs(ts: string): number {
  const clean = ts.replace(/\.\d+$/, '');
  const parts = clean.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 3) return parts[0]! * 3_600_000 + parts[1]! * 60_000 + parts[2]! * 1000;
  if (parts.length === 2) return parts[0]! * 60_000 + parts[1]! * 1000;
  throw new Error(`bad timestamp: ${ts}`);
}

const SUMMARY_RE = /## Summary\s*\n([\s\S]*?)(?=\n## |$)/i;
const CHAPTERS_RE = /## Chapters\s*\n([\s\S]*?)$/i;
const CHAPTER_LINE_RE = /^[-*]\s+\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*[–\-—→~]\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?\]?\s*[:：]?\s*(.+?)(?:\s+[—–-]\s+(.+))?$/;

export function parseInsights(md: string): Insights {
  const chMatch = CHAPTERS_RE.exec(md);
  // Small local models often ignore the `## Summary` / `## Chapters` headings
  // and just dump prose. When the heading is missing, treat everything up to
  // a (possibly missing) Chapters heading as the summary block — a best-effort
  // salvage so PARSE_FAILED only fires when the model produced literally nothing.
  let sumBlock = SUMMARY_RE.exec(md)?.[1]?.trim() ?? '';
  if (!sumBlock) {
    sumBlock = (chMatch ? md.slice(0, chMatch.index) : md).trim();
  }
  let summary = '';
  const bullets: string[] = [];

  if (sumBlock) {
    const lines = sumBlock.split('\n');
    const paraLines: string[] = [];
    let inBullets = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        inBullets = true;
        bullets.push(trimmed.slice(2).trim());
      } else if (!inBullets && trimmed) {
        paraLines.push(trimmed);
      }
    }
    summary = paraLines.join(' ').trim();
  }

  const chBlock = chMatch?.[1] ?? '';
  const chapters: Chapter[] = [];
  for (const line of chBlock.split('\n')) {
    const m = CHAPTER_LINE_RE.exec(line.trim());
    if (!m) continue;
    try {
      chapters.push({
        startMs: tsToMs(m[1]!),
        title: m[2]!.trim(),
        description: (m[3] ?? '').trim(),
      });
    } catch {
      // skip malformed timestamps
    }
  }

  if (!summary && bullets.length === 0 && chapters.length === 0) {
    throw new Error('PARSE_FAILED: neither summary nor chapters extractable');
  }

  return { summary, summaryBullets: bullets, chapters };
}

export function snapChapters(chapters: readonly Chapter[], cues: readonly Cue[]): Chapter[] {
  if (cues.length === 0) return [];
  const lastEnd = cues[cues.length - 1]!.endMs;
  const starts = cues.map((c) => c.startMs);

  function nearest(ms: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! < ms) lo = mid + 1;
      else hi = mid;
    }
    const above = starts[lo]!;
    const below = lo > 0 ? starts[lo - 1]! : above;
    return Math.abs(above - ms) < Math.abs(below - ms) ? above : below;
  }

  const seen = new Set<number>();
  const out: Chapter[] = [];
  for (const ch of chapters) {
    if (ch.startMs > lastEnd) continue;
    const snapped = nearest(ch.startMs);
    if (seen.has(snapped)) continue;
    seen.add(snapped);
    out.push({ ...ch, startMs: snapped });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
