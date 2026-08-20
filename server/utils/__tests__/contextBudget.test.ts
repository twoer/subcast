/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSIGHT_CONTEXT_BUDGET,
  estimateTextTokens,
  planInsightContext,
} from '../contextBudget';

describe('Insight context budget', () => {
  it('keeps short transcripts on the single-pass path', () => {
    const transcript = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello world\n';
    const plan = planInsightContext(transcript);

    expect(plan.mode).toBe('single');
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.text).toBe(transcript);
    expect(plan.windows[0]!.maxOutputTokens).toBe(DEFAULT_INSIGHT_CONTEXT_BUDGET.finalOutputTokens);
  });

  it('splits long transcripts into ordered windows without dropping text', () => {
    const transcript = Array.from({ length: 18 }, (_, i) =>
      `00:00:${String(i).padStart(2, '0')}.000 --> 00:00:${String(i + 1).padStart(2, '0')}.000\n`
      + `line ${i} ${'word '.repeat(16)}`,
    ).join('\n\n');

    const plan = planInsightContext(transcript, {
      contextWindowTokens: 96,
      finalOutputTokens: 32,
      mapOutputTokens: 16,
      safetyMarginTokens: 8,
      promptOverheadTokens: 4,
    });

    expect(plan.mode).toBe('map-reduce');
    expect(plan.windows.length).toBeGreaterThan(1);
    expect(plan.windows.map((w) => w.index)).toEqual(plan.windows.map((_, i) => i));
    expect(plan.windows.map((w) => w.text).join('')).toBe(transcript);
  });

  it('reserves output and safety budget for every map window', () => {
    const transcript = `${'alpha beta gamma delta\n'.repeat(100)}`;
    const plan = planInsightContext(transcript, {
      contextWindowTokens: 128,
      finalOutputTokens: 48,
      mapOutputTokens: 24,
      safetyMarginTokens: 12,
      promptOverheadTokens: 8,
    });

    expect(plan.mode).toBe('map-reduce');
    for (const window of plan.windows) {
      expect(window.estimatedInputTokens).toBeLessThanOrEqual(window.maxInputTokens);
      expect(window.maxInputTokens + window.maxOutputTokens + plan.safetyMarginTokens + 8)
        .toBeLessThanOrEqual(plan.contextWindowTokens);
    }
  });

  it('estimates CJK text conservatively compared with ASCII text', () => {
    expect(estimateTextTokens('你好世界')).toBeGreaterThanOrEqual(4);
    expect(estimateTextTokens('hello world')).toBeLessThan(estimateTextTokens('你好世界你好世界'));
  });

  it('counts VTT timestamp punctuation so prompt-heavy cue lists use map/reduce', () => {
    const transcript = [
      'WEBVTT',
      '',
      ...Array.from({ length: 220 }, (_, i) => [
        `00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 --> 00:${String(Math.floor((i + 1) / 60)).padStart(2, '0')}:${String((i + 1) % 60).padStart(2, '0')}.000`,
        'ok',
      ].join('\n')),
    ].join('\n\n');

    const plan = planInsightContext(transcript);

    expect(plan.mode).toBe('map-reduce');
  });

  it('keeps dense ASCII VTT windows below the map input budget', () => {
    const transcript = [
      'WEBVTT',
      '',
      ...Array.from({ length: 90 }, (_, i) => [
        `00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 --> 00:${String(Math.floor((i + 1) / 60)).padStart(2, '0')}:${String((i + 1) % 60).padStart(2, '0')}.000`,
        `${'structured ascii phrase '.repeat(8)}${i}`,
      ].join('\n')),
    ].join('\n\n');
    const plan = planInsightContext(transcript);

    expect(estimateTextTokens(transcript)).toBeGreaterThanOrEqual(Math.ceil(transcript.length / 2));
    expect(plan.mode).toBe('map-reduce');
    expect(Math.max(...plan.windows.map((w) => w.text.length))).toBeLessThanOrEqual(12_544);
  });
});
