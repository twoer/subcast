/* SPDX-License-Identifier: Apache-2.0 */
import type { LLMMessage } from './llmClient';
import {
  parseInsights,
  snapChapters,
  type Chapter,
  type Insights,
} from './insights';
import type { Cue } from './vtt';

const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
};

export interface PartialInsight {
  summary: string;
  summaryBullets: string[];
  chapters: Chapter[];
}

const PARTIAL_SUMMARY_MAX_CHARS = 700;
const PARTIAL_BULLET_MAX_CHARS = 220;
const PARTIAL_TITLE_MAX_CHARS = 90;
const PARTIAL_DESCRIPTION_MAX_CHARS = 180;

export const PARTIAL_INSIGHT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'summaryBullets', 'chapters'],
  properties: {
    summary: { type: 'string', maxLength: PARTIAL_SUMMARY_MAX_CHARS },
    summaryBullets: {
      type: 'array',
      items: { type: 'string', maxLength: PARTIAL_BULLET_MAX_CHARS },
      minItems: 0,
      maxItems: 5,
    },
    chapters: {
      type: 'array',
      minItems: 0,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startMs', 'title', 'description'],
        properties: {
          startMs: { type: 'number' },
          title: { type: 'string', maxLength: PARTIAL_TITLE_MAX_CHARS },
          description: { type: 'string', maxLength: PARTIAL_DESCRIPTION_MAX_CHARS },
        },
      },
    },
  },
};

function langName(uiLanguage: string): string {
  return LANG_NAMES[uiLanguage] ?? 'English';
}

function compactText(value: string, maxChars: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactPartialInsight(partial: PartialInsight): PartialInsight {
  return {
    summary: compactText(partial.summary, PARTIAL_SUMMARY_MAX_CHARS),
    summaryBullets: partial.summaryBullets
      .slice(0, 5)
      .map((item) => compactText(item, PARTIAL_BULLET_MAX_CHARS))
      .filter(Boolean),
    chapters: partial.chapters.slice(0, 5).map((chapter) => ({
      startMs: chapter.startMs,
      title: compactText(chapter.title, PARTIAL_TITLE_MAX_CHARS),
      description: compactText(chapter.description, PARTIAL_DESCRIPTION_MAX_CHARS),
    })).filter((chapter) => chapter.title),
  };
}

export function buildInsightMapMessages(input: {
  transcriptWindow: string;
  uiLanguage: 'zh-CN' | 'en';
  windowIndex: number;
  totalWindows: number;
}): LLMMessage[] {
  const system = [
    'You are summarizing one window of a longer video transcript.',
    `LANGUAGE: All output text MUST be in ${langName(input.uiLanguage)}.`,
    'Return ONLY JSON matching this shape:',
    '{"summary":"...","summaryBullets":["..."],"chapters":[{"startMs":0,"title":"...","description":"..."}]}',
    'Chapter startMs must be milliseconds from the original video timestamp shown in the VTT window.',
    'Do not include transcript text, code fences, or commentary.',
  ].join('\n');

  const user = [
    `WINDOW ${input.windowIndex + 1}/${input.totalWindows}`,
    '',
    'TRANSCRIPT WINDOW:',
    '',
    input.transcriptWindow,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function buildInsightReduceMessages(input: {
  uiLanguage: 'zh-CN' | 'en';
  partials: readonly PartialInsight[];
}): LLMMessage[] {
  const compactPartials = input.partials.map(compactPartialInsight);
  const system = [
    'You are reducing partial video summaries into one final video insight.',
    `LANGUAGE: All output text MUST be in ${langName(input.uiLanguage)}.`,
    'Output strict markdown following exactly this template. Do not add any other sections, code fences, or commentary.',
    '',
    '## Summary',
    '',
    '<one paragraph, 100-300 words>',
    '',
    '- <key point 1>',
    '- <key point 2>',
    '- <key point 3>',
    '',
    '## Chapters',
    '',
    '- [HH:MM:SS] <Chapter title> — <one-sentence description>',
  ].join('\n');

  const user = [
    'PARTIAL INSIGHTS JSON:',
    JSON.stringify(compactPartials),
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function stripJsonFence(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }
  return s.trim();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asChapters(value: unknown): Chapter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Chapter[] => {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.startMs !== 'number' || !Number.isFinite(row.startMs)) return [];
    return [{
      startMs: Math.max(0, Math.floor(row.startMs)),
      title: typeof row.title === 'string' ? row.title : '',
      description: typeof row.description === 'string' ? row.description : '',
    }];
  }).filter((chapter) => chapter.title.trim());
}

export function parsePartialInsight(raw: string): PartialInsight {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error('PARTIAL_INSIGHT_PARSE_FAILED');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('PARTIAL_INSIGHT_PARSE_FAILED');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    ...compactPartialInsight({
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      summaryBullets: asStringArray(obj.summaryBullets),
      chapters: asChapters(obj.chapters),
    }),
  };
}

export function finalizeReducedInsightMarkdown(markdown: string, cues: readonly Cue[]): Insights {
  const parsed = parseInsights(markdown);
  return { ...parsed, chapters: snapChapters(parsed.chapters, cues) };
}
