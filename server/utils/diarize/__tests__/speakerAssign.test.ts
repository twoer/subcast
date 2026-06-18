/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { resolveCueSpeaker } from '../speakerAssign';
import type { Cue } from '../../vtt';
import type { ChunkSpeakerTimelineEntry, SpeakerId } from '#shared/diarization';

const cue = (startMs: number, endMs: number, text = 'hello world'): Cue => ({
  startMs,
  endMs,
  text,
});
const seg = (startMs: number, endMs: number, speakerId: SpeakerId): ChunkSpeakerTimelineEntry => ({
  startMs,
  endMs,
  speakerId,
});

describe('resolveCueSpeaker — single', () => {
  it('full cue under one speaker → single 100%', () => {
    const r = resolveCueSpeaker(cue(0, 5000), [seg(0, 5000, 'speaker_A')]);
    expect(r).toEqual({ kind: 'single', speakerId: 'speaker_A', coverageRatio: 1 });
  });

  it('dominant speaker ≥ 70% → single (ignores tiny intruder)', () => {
    // A covers 4s/5s = 80%, B covers 0.5s/5s = 10%, total 90% (> 30% floor).
    // Dominant 80% > 70% → single A.
    const r = resolveCueSpeaker(cue(0, 5000), [
      seg(0, 4000, 'speaker_A'),
      seg(4500, 5000, 'speaker_B'),
    ]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') {
      expect(r.speakerId).toBe('speaker_A');
      expect(r.coverageRatio).toBeCloseTo(0.8, 2);
    }
  });

  it('grey zone 30%-70% → single dominant with low coverageRatio', () => {
    // A covers 50%, B 20% (each < 25% split threshold), total 70%, A
    // dominant 50% < 70% single floor. Result: single A with grey ratio.
    const r = resolveCueSpeaker(cue(0, 10000), [
      seg(0, 5000, 'speaker_A'),
      seg(5000, 7000, 'speaker_B'),
    ]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') {
      expect(r.speakerId).toBe('speaker_A');
      expect(r.coverageRatio).toBeCloseTo(0.5, 2);
    }
  });
});

describe('resolveCueSpeaker — none', () => {
  it('total coverage < 30% → none', () => {
    // Q3 example from the doc: 5s cue, 0.5s A + 0.5s B = 20% coverage.
    const r = resolveCueSpeaker(cue(0, 5000), [
      seg(500, 1000, 'speaker_A'),
      seg(2000, 2500, 'speaker_B'),
    ]);
    expect(r).toEqual({ kind: 'none' });
  });

  it('empty timeline → none', () => {
    const r = resolveCueSpeaker(cue(0, 5000), []);
    expect(r).toEqual({ kind: 'none' });
  });

  it('zero-duration cue → none', () => {
    const r = resolveCueSpeaker(cue(1000, 1000), [seg(0, 2000, 'speaker_A')]);
    expect(r).toEqual({ kind: 'none' });
  });
});

describe('resolveCueSpeaker — split', () => {
  it('50/50 split → 2 parts with punctuation snap', () => {
    // 4s cue. A speaks 0-2s, B speaks 2-4s. Text has a midpoint punct.
    const c = cue(0, 4000, '今天我们讨论这个问题。我同意你的看法。');
    const r = resolveCueSpeaker(c, [
      seg(0, 2000, 'speaker_A'),
      seg(2000, 4000, 'speaker_B'),
    ]);

    expect(r.kind).toBe('split');
    if (r.kind === 'split') {
      expect(r.parts).toHaveLength(2);
      expect(r.parts[0]!.speakerId).toBe('speaker_A');
      expect(r.parts[1]!.speakerId).toBe('speaker_B');
      // Should snap to the 。 between the two sentences.
      expect(r.parts[0]!.text).toContain('讨论');
      expect(r.parts[1]!.text).toContain('看法');
    }
  });

  it('CJK codepoint slicing is safe', () => {
    const c = cue(0, 4000, '一二三四五六七八九十一二三四五六');
    const r = resolveCueSpeaker(c, [
      seg(0, 2000, 'speaker_A'),
      seg(2000, 4000, 'speaker_B'),
    ]);
    expect(r.kind).toBe('split');
    if (r.kind === 'split') {
      const combined = r.parts.map((p) => p.text).join('');
      // Every character preserved.
      expect(combined.length).toBe(c.text.length);
    }
  });

  it('emoji surrogate-safe (no broken codepoints)', () => {
    // 🎉 + 🚀 are surrogate pairs. Array.from + join handles them.
    const c = cue(0, 4000, '🎉 win 🚀 boom 🎊 done');
    const r = resolveCueSpeaker(c, [
      seg(0, 2000, 'speaker_A'),
      seg(2000, 4000, 'speaker_B'),
    ]);
    if (r.kind === 'split') {
      const combined = r.parts.map((p) => p.text).join(' ');
      expect(combined).toContain('🎉');
      expect(combined).toContain('🚀');
      expect(combined).toContain('🎊');
    }
  });

  it('< 25% per speaker → not split, falls back to dominant', () => {
    // A 60%, B 24% (just below 25% threshold), total 84% (>30%).
    // Should NOT split. Dominant A 60% < 70%, so single grey-zone A.
    const r = resolveCueSpeaker(cue(0, 10000), [
      seg(0, 6000, 'speaker_A'),
      seg(6000, 8400, 'speaker_B'),
    ]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') expect(r.speakerId).toBe('speaker_A');
  });
});

describe('resolveCueSpeaker — boundary edges', () => {
  it('cue extends past the timeline → still works (uses overlap)', () => {
    // Cue 0-10s, timeline only covers 0-5s. Coverage = 50%.
    const r = resolveCueSpeaker(cue(0, 10000), [seg(0, 5000, 'speaker_A')]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') {
      expect(r.speakerId).toBe('speaker_A');
      expect(r.coverageRatio).toBeCloseTo(0.5, 2);
    }
  });

  it('multiple timeline entries from same speaker are summed', () => {
    // A speaks 0-2 and 3-5, intermediate gap. Total A coverage = 4s/5s = 80%.
    const r = resolveCueSpeaker(cue(0, 5000), [
      seg(0, 2000, 'speaker_A'),
      seg(3000, 5000, 'speaker_A'),
    ]);
    expect(r.kind).toBe('single');
    if (r.kind === 'single') {
      expect(r.coverageRatio).toBeCloseTo(0.8, 2);
    }
  });
});
