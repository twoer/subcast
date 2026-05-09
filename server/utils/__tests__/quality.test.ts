import { describe, it, expect } from 'vitest';
import { detectHallucination } from '../quality';
import type { Cue } from '../vtt';

const c = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('detectHallucination', () => {
  it('returns null for a clean chunk', () => {
    const cues = [
      c(0, 1500, 'and so my fellow'),
      c(1500, 4000, 'Americans'),
      c(4000, 6000, 'ask not'),
    ];
    expect(detectHallucination(cues, 30_000)).toBeNull();
  });

  it('flags repeat when 3 consecutive cues share trimmed text', () => {
    const cues = [
      c(0, 1000, 'hello'),
      c(1000, 2000, ' hello '),
      c(2000, 3000, 'hello'),
    ];
    expect(detectHallucination(cues, 30_000)).toBe('repeat');
  });

  it('does NOT flag repeat when only 2 consecutive cues match', () => {
    const cues = [
      c(0, 1000, 'hi'),
      c(1000, 2000, 'hi'),
      c(2000, 3000, 'bye'),
    ];
    expect(detectHallucination(cues, 30_000)).toBeNull();
  });

  it('flags reverse-ts on a single decreasing startMs', () => {
    const cues = [
      c(0, 1000, 'a'),
      c(2000, 3000, 'b'),
      c(1500, 4000, 'c'), // out of order
    ];
    expect(detectHallucination(cues, 30_000)).toBe('reverse-ts');
  });

  it('flags density when cue count exceeds 1.5 per second', () => {
    // 30s chunk → threshold = 45 cues; 50 trips it
    const cues = Array.from({ length: 50 }, (_, i) => c(i * 600, i * 600 + 300, `t${i}`));
    expect(detectHallucination(cues, 30_000)).toBe('density');
  });

  it('skips density check for chunks < 10s', () => {
    // 5s chunk, 100 cues → would trip density on a 30s chunk
    const cues = Array.from({ length: 100 }, (_, i) => c(i * 50, i * 50 + 30, `t${i}`));
    expect(detectHallucination(cues, 5_000)).toBeNull();
  });

  it('handles empty cue list', () => {
    expect(detectHallucination([], 30_000)).toBeNull();
  });

  it('returns first matching reason when multiple apply', () => {
    // repeat triggers before reverse-ts in the loop order
    const cues = [
      c(1000, 2000, 'a'),
      c(2000, 3000, 'a'),
      c(3000, 4000, 'a'),
      c(500, 5000, 'b'), // would also be reverse-ts
    ];
    expect(detectHallucination(cues, 30_000)).toBe('repeat');
  });
});
