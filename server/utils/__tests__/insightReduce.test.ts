/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  PARTIAL_INSIGHT_SCHEMA,
  buildInsightMapMessages,
  buildInsightReduceMessages,
  finalizeReducedInsightMarkdown,
  parsePartialInsight,
} from '../insightReduce';
import type { Cue } from '../vtt';

describe('Insight map/reduce helpers', () => {
  it('builds map messages with a strict partial JSON contract', () => {
    const messages = buildInsightMapMessages({
      transcriptWindow: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
      uiLanguage: 'zh-CN',
      windowIndex: 0,
      totalWindows: 2,
    });

    expect(messages[0]!.content).toContain('Simplified Chinese');
    expect(messages.at(-1)!.content).toContain('WINDOW 1/2');
    expect(PARTIAL_INSIGHT_SCHEMA).toMatchObject({
      type: 'object',
      required: ['summary', 'summaryBullets', 'chapters'],
    });
  });

  it('parses fenced partial JSON and keeps only the existing Insight fields', () => {
    const partial = parsePartialInsight([
      '```json',
      JSON.stringify({
        summary: 'Window summary',
        summaryBullets: ['A', 'B'],
        chapters: [{ startMs: 1000, title: 'Intro', description: 'Start' }],
        rawTranscript: 'must not survive',
      }),
      '```',
    ].join('\n'));

    expect(partial).toEqual({
      summary: 'Window summary',
      summaryBullets: ['A', 'B'],
      chapters: [{ startMs: 1000, title: 'Intro', description: 'Start' }],
    });
    expect(JSON.stringify(partial)).not.toContain('rawTranscript');
  });

  it('builds reduce messages from partials instead of full transcript text', () => {
    const messages = buildInsightReduceMessages({
      uiLanguage: 'en',
      partials: [
        { summary: 'First window', summaryBullets: ['A'], chapters: [] },
        { summary: 'Second window', summaryBullets: ['B'], chapters: [] },
      ],
    });

    const prompt = messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('First window');
    expect(prompt).toContain('Second window');
    expect(prompt).toContain('## Summary');
    expect(prompt).toContain('## Chapters');
  });

  it('finalizes reduced markdown into the existing Insights shape', () => {
    const cues: Cue[] = [
      { startMs: 0, endMs: 900, text: 'a' },
      { startMs: 5000, endMs: 5900, text: 'b' },
    ];
    const insights = finalizeReducedInsightMarkdown([
      '## Summary',
      '',
      'Final summary.',
      '',
      '- One',
      '',
      '## Chapters',
      '',
      '- [00:00:04] Setup — Near second cue',
    ].join('\n'), cues);

    expect(insights).toEqual({
      summary: 'Final summary.',
      summaryBullets: ['One'],
      chapters: [{ startMs: 5000, title: 'Setup', description: 'Near second cue' }],
    });
  });
});
