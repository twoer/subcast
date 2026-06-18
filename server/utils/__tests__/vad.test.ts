/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { probsToSegments, refineSegments } from '../vad';

// All pure-helper tests below. The I/O path (detectSpeechSegments)
// is exercised end-to-end by a separate ffmpeg-based fixture test only
// when the Silero model is present locally — see vadSession.test.ts
// for that gating pattern. Splitting the state machine out keeps these
// tests deterministic and fast.

describe('probsToSegments (state machine)', () => {
  it('emits one run when probs cross enter→exit cleanly', () => {
    // Frames: 0=silence 1=silence 2=speech 3=speech 4=silence 5=silence
    // enter 0.5, exit 0.35 → run starts at frame 2 (t=60), ends at frame 4 (t=120)
    const out = probsToSegments([0.1, 0.1, 0.8, 0.7, 0.1, 0.1]);
    expect(out).toEqual([{ startMs: 60, endMs: 120 }]);
  });

  it('hysteresis: dip below enter but above exit keeps the run alive', () => {
    // Frame 3 drops to 0.4 — between exit (0.35) and enter (0.5).
    // Without hysteresis (single 0.5 threshold) the run would split.
    const out = probsToSegments([0.1, 0.8, 0.6, 0.4, 0.7, 0.1]);
    expect(out).toEqual([{ startMs: 30, endMs: 150 }]);
  });

  it('handles a run that extends to end-of-stream', () => {
    const out = probsToSegments([0.1, 0.1, 0.8, 0.8]);
    expect(out).toEqual([{ startMs: 60, endMs: 120 }]);
  });

  it('returns empty when no frame ever crosses enter threshold', () => {
    expect(probsToSegments([0.1, 0.2, 0.3, 0.4])).toEqual([]);
  });

  it('rejects enterThreshold < exitThreshold (invalid hysteresis)', () => {
    expect(() => probsToSegments([0.5], 0.3, 0.5)).toThrow(/hysteresis/);
  });
});

describe('refineSegments (merge + min-duration filter)', () => {
  it('merges segments whose gap is below mergeGapMs', () => {
    const merged = refineSegments(
      [
        { startMs: 0, endMs: 500 },
        { startMs: 700, endMs: 1200 }, // 200 ms gap
      ],
      0,    // min = 0 to isolate merge behavior
      300,  // merge < 300 ms gaps
    );
    expect(merged).toEqual([{ startMs: 0, endMs: 1200 }]);
  });

  it('does NOT merge segments whose gap meets or exceeds mergeGapMs', () => {
    const merged = refineSegments(
      [
        { startMs: 0, endMs: 500 },
        { startMs: 800, endMs: 1200 }, // 300 ms gap, equal to threshold → not merged
      ],
      0,
      300,
    );
    expect(merged).toHaveLength(2);
  });

  it('drops runs shorter than minSegmentMs AFTER merging', () => {
    // Two 200 ms runs separated by 50 ms gap → merge → 450 ms total. minMs=300 → kept.
    const a = refineSegments(
      [
        { startMs: 0, endMs: 200 },
        { startMs: 250, endMs: 450 },
      ],
      300,
      500,
    );
    expect(a).toEqual([{ startMs: 0, endMs: 450 }]);

    // Same two runs but minMs=500 → still dropped after merge.
    const b = refineSegments(
      [
        { startMs: 0, endMs: 200 },
        { startMs: 250, endMs: 450 },
      ],
      500,
      500,
    );
    expect(b).toEqual([]);
  });

  it('returns a fresh array (mutation-free)', () => {
    const input: ReadonlyArray<{ startMs: number; endMs: number }> = [
      { startMs: 0, endMs: 1000 },
    ];
    const out = refineSegments(input, 0, 0);
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
  });
});
