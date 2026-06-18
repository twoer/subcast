/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { buildPrompt, parseInsights, snapChapters } from '../insights';
import type { Cue } from '../vtt';

describe('buildPrompt', () => {
  it('includes transcript and language directive', () => {
    const out = buildPrompt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n', 'zh-CN');
    expect(out).toContain('Simplified Chinese');
    expect(out).toContain('Hello');
    expect(out).toContain('## Summary');
    expect(out).toContain('## Chapters');
  });

  it('defaults unknown locale to English instruction', () => {
    const out = buildPrompt('WEBVTT\n', 'fr-FR');
    expect(out).toContain('English');
  });
});

describe('parseInsights strict', () => {
  it('parses full template', () => {
    const md = [
      '## Summary',
      '',
      'This is the summary paragraph.',
      '',
      '- Point one',
      '- Point two',
      '',
      '## Chapters',
      '',
      '- [00:00:00] Intro — opening remarks',
      '- [00:03:24] Setup — installing dependencies',
    ].join('\n');
    const out = parseInsights(md);
    expect(out.summary).toBe('This is the summary paragraph.');
    expect(out.summaryBullets).toEqual(['Point one', 'Point two']);
    expect(out.chapters).toHaveLength(2);
    expect(out.chapters[0]).toEqual({ startMs: 0, title: 'Intro', description: 'opening remarks' });
    expect(out.chapters[1]).toEqual({ startMs: 3 * 60_000 + 24_000, title: 'Setup', description: 'installing dependencies' });
  });

  it('accepts MM:SS timestamps too', () => {
    const md = '## Summary\n\nx\n\n## Chapters\n\n- [03:24] Setup\n';
    const out = parseInsights(md);
    expect(out.chapters[0]!.startMs).toBe(204_000);
  });

  it('lenient: missing Chapters section → empty array', () => {
    const md = '## Summary\n\nOnly summary here.\n';
    const out = parseInsights(md);
    expect(out.summary).toBe('Only summary here.');
    expect(out.chapters).toEqual([]);
  });

  it('throws on empty / whitespace-only input', () => {
    expect(() => parseInsights('')).toThrow();
    expect(() => parseInsights('   \n  \n')).toThrow();
  });

  it('salvages prose when model drops the ## Summary heading', () => {
    const md = [
      'This is a transcript of an educational video.',
      '',
      '1. The teacher introduces the lesson.',
      '2. Students complete the exercise.',
      '',
      '- key takeaway one',
      '- key takeaway two',
    ].join('\n');
    const out = parseInsights(md);
    expect(out.summary).toContain('This is a transcript');
    expect(out.summaryBullets).toEqual(['key takeaway one', 'key takeaway two']);
    expect(out.chapters).toEqual([]);
  });

  it('salvages prose before a ## Chapters heading when Summary heading is missing', () => {
    const md = [
      'Free-form prose acting as summary.',
      '',
      '## Chapters',
      '',
      '- [00:01:00] Intro',
    ].join('\n');
    const out = parseInsights(md);
    expect(out.summary).toBe('Free-form prose acting as summary.');
    expect(out.chapters).toHaveLength(1);
  });

  it('bullets-only summary (no paragraph) still counts as parsed', () => {
    const md = '## Summary\n\n- Point A\n- Point B\n';
    const out = parseInsights(md);
    expect(out.summary).toBe('');
    expect(out.summaryBullets).toEqual(['Point A', 'Point B']);
  });

  it('accepts chapter timestamps with milliseconds + time ranges', () => {
    const md = '## Summary\n\nx\n\n## Chapters\n\n- [00:00:06.680–00:01:07.740] 会议开始\n';
    const out = parseInsights(md);
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0]!.startMs).toBe(6 * 1000);
    expect(out.chapters[0]!.title).toBe('会议开始');
  });

  it('accepts chapter lines without brackets', () => {
    const md = '## Summary\n\nx\n\n## Chapters\n\n- 03:24 Setup section\n';
    const out = parseInsights(md);
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0]!.startMs).toBe(204_000);
    expect(out.chapters[0]!.title).toBe('Setup section');
  });

  it('accepts chapters with asterisk bullet marker', () => {
    const md = '## Summary\n\nx\n\n## Chapters\n\n* [00:30] Intro\n';
    const out = parseInsights(md);
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0]!.title).toBe('Intro');
  });

  it('accepts time range with arrow separator', () => {
    const md = '## Summary\n\nx\n\n## Chapters\n\n- [00:00:02.520→00:00:15.300] 拒绝强制隔离\n';
    const out = parseInsights(md);
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0]!.startMs).toBe(2 * 1000);
    expect(out.chapters[0]!.title).toBe('拒绝强制隔离');
  });
});

describe('snapChapters', () => {
  const cue = (s: number, e: number): Cue => ({ startMs: s, endMs: e, text: 'x' });

  it('snaps to nearest cue start', () => {
    const cues = [cue(0, 1000), cue(3500, 4000), cue(10_000, 11_000)];
    const chs = snapChapters(
      [
        { startMs: 100, title: 'a', description: '' },
        { startMs: 3300, title: 'b', description: '' },
        { startMs: 9800, title: 'c', description: '' },
      ],
      cues,
    );
    expect(chs.map((c) => c.startMs)).toEqual([0, 3500, 10_000]);
  });

  it('dedupes adjacent same-startMs chapters (keeps first)', () => {
    const cues = [cue(0, 1000)];
    const chs = snapChapters(
      [
        { startMs: 100, title: 'a', description: 'one' },
        { startMs: 200, title: 'b', description: 'two' },
      ],
      cues,
    );
    expect(chs).toHaveLength(1);
    expect(chs[0]!.title).toBe('a');
  });

  it('drops chapters beyond the last cue', () => {
    const cues = [cue(0, 1000), cue(2000, 3000)];
    const chs = snapChapters(
      [{ startMs: 1000, title: 'ok', description: '' }, { startMs: 99_999, title: 'far', description: '' }],
      cues,
    );
    expect(chs).toHaveLength(1);
  });
});
