import { describe, it, expect } from 'vitest';
import { findSilentGaps } from '../silence';
import type { Cue } from '../vtt';

const c = (startMs: number, endMs: number, text = 'x'): Cue => ({ startMs, endMs, text });

describe('findSilentGaps', () => {
  it('returns empty for a single cue', () => {
    expect(findSilentGaps([c(0, 1000)], 10_000)).toEqual([]);
  });

  it('returns empty when all gaps < threshold', () => {
    const cues = [c(0, 1000), c(1500, 3000), c(5000, 6000)];
    expect(findSilentGaps(cues, 10_000)).toEqual([]);
  });

  it('captures a gap exactly equal to the threshold', () => {
    const cues = [c(0, 1000), c(11_000, 12_000)];
    expect(findSilentGaps(cues, 10_000)).toEqual([
      { afterCueIdx: 0, startMs: 1000, endMs: 11_000, durationMs: 10_000 },
    ]);
  });

  it('captures multiple gaps in cue order', () => {
    const cues = [
      c(0, 1000),
      c(15_000, 16_000),    // gap1: 14s
      c(20_000, 21_000),    // small gap, ignored
      c(40_000, 41_000),    // gap2: 19s
    ];
    const gaps = findSilentGaps(cues, 10_000);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.afterCueIdx).toBe(0);
    expect(gaps[0]?.durationMs).toBe(14_000);
    expect(gaps[1]?.afterCueIdx).toBe(2);
    expect(gaps[1]?.durationMs).toBe(19_000);
  });

  it('does not include a gap before the first cue or after the last', () => {
    const cues = [c(50_000, 51_000), c(70_000, 71_000)];
    const gaps = findSilentGaps(cues, 10_000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.afterCueIdx).toBe(0);
  });

  it('handles empty input', () => {
    expect(findSilentGaps([], 10_000)).toEqual([]);
  });
});
