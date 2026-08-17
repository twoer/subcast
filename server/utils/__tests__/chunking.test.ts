/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import {
  packVadSegmentsForWhisper,
  planChunksByDuration,
  planChunksFromVad,
} from '#shared/chunking';

const seg = (s: number, e: number) => ({ startMs: s * 1000, endMs: e * 1000 });

describe('planChunksFromVad', () => {
  it('single segment shorter than max → one chunk equal to segment', () => {
    const chunks = planChunksFromVad([seg(0, 12)], { maxChunkSec: 30 });
    expect(chunks).toEqual([{ startMs: 0, endMs: 12_000 }]);
  });

  it('single segment longer than max → split at cap boundaries', () => {
    const chunks = planChunksFromVad([seg(0, 75)], { maxChunkSec: 30 });
    expect(chunks).toEqual([
      { startMs: 0, endMs: 30_000 },
      { startMs: 30_000, endMs: 60_000 },
      { startMs: 60_000, endMs: 75_000 },
    ]);
  });

  it('multiple separate segments stay separate', () => {
    const chunks = planChunksFromVad(
      [seg(0, 5), seg(15, 20), seg(40, 45)],
      { maxChunkSec: 30 },
    );
    expect(chunks).toEqual([
      { startMs: 0, endMs: 5_000 },
      { startMs: 15_000, endMs: 20_000 },
      { startMs: 40_000, endMs: 45_000 },
    ]);
  });

  it('one long + one short segment → split long, keep short', () => {
    const chunks = planChunksFromVad(
      [seg(0, 70), seg(80, 85)],
      { maxChunkSec: 30 },
    );
    expect(chunks).toEqual([
      { startMs: 0, endMs: 30_000 },
      { startMs: 30_000, endMs: 60_000 },
      { startMs: 60_000, endMs: 70_000 },
      { startMs: 80_000, endMs: 85_000 },
    ]);
  });

  it('empty input → empty plan', () => {
    expect(planChunksFromVad([], { maxChunkSec: 30 })).toEqual([]);
  });

  it('skips zero / negative span segments defensively', () => {
    const chunks = planChunksFromVad(
      [{ startMs: 1000, endMs: 1000 }, { startMs: 5000, endMs: 4000 }, seg(10, 15)],
      { maxChunkSec: 30 },
    );
    expect(chunks).toEqual([{ startMs: 10_000, endMs: 15_000 }]);
  });

  it('rejects invalid maxChunkSec', () => {
    expect(() => planChunksFromVad([], { maxChunkSec: 0 })).toThrow();
    expect(() => planChunksFromVad([], { maxChunkSec: -5 })).toThrow();
    expect(() => planChunksFromVad([], { maxChunkSec: NaN })).toThrow();
  });
});

describe('planChunksByDuration (legacy fallback)', () => {
  it('exact-multiple duration produces uniform chunks', () => {
    const plans = planChunksByDuration(90, { maxChunkSec: 30 });
    expect(plans).toEqual([
      { startMs: 0, endMs: 30_000 },
      { startMs: 30_000, endMs: 60_000 },
      { startMs: 60_000, endMs: 90_000 },
    ]);
  });

  it('non-exact duration → last chunk is short', () => {
    const plans = planChunksByDuration(75, { maxChunkSec: 30 });
    expect(plans).toHaveLength(3);
    expect(plans[2]).toEqual({ startMs: 60_000, endMs: 75_000 });
  });

  it('short duration → single small chunk', () => {
    const plans = planChunksByDuration(5, { maxChunkSec: 30 });
    expect(plans).toEqual([{ startMs: 0, endMs: 5_000 }]);
  });

  it('zero / negative duration → empty plan', () => {
    expect(planChunksByDuration(0, { maxChunkSec: 30 })).toEqual([]);
    expect(planChunksByDuration(-1, { maxChunkSec: 30 })).toEqual([]);
  });
});

describe('packVadSegmentsForWhisper', () => {
  it('packs separate segments into one dense request, gaps excluded', () => {
    const plans = packVadSegmentsForWhisper(
      [seg(0, 2), seg(10, 12), seg(30, 33)],
      { maxSpeechSec: 30 },
    );
    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.speechMs).toBe(7_000);
    expect(p.startMs).toBe(0);
    expect(p.endMs).toBe(33_000); // span includes gaps, speech does not
    expect(p.pieces).toEqual([
      { reqStartMs: 0, absStartMs: 0, durMs: 2_000 },
      { reqStartMs: 2_000, absStartMs: 10_000, durMs: 2_000 },
      { reqStartMs: 4_000, absStartMs: 30_000, durMs: 3_000 },
    ]);
  });

  it('flushes a plan when the next piece would exceed the speech cap', () => {
    const plans = packVadSegmentsForWhisper(
      [seg(0, 20), seg(25, 27), seg(100, 110)],
      { maxSpeechSec: 30 },
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]!.speechMs).toBe(22_000);
    expect(plans[0]!.pieces).toHaveLength(2);
    expect(plans[1]!.pieces).toEqual([
      { reqStartMs: 0, absStartMs: 100_000, durMs: 10_000 },
    ]);
  });

  it('splits a segment longer than the cap at the cap boundary', () => {
    const plans = packVadSegmentsForWhisper([seg(0, 75)], { maxSpeechSec: 30 });
    expect(plans.map((p) => p.speechMs)).toEqual([30_000, 30_000, 15_000]);
    expect(plans[0]!.pieces).toEqual([
      { reqStartMs: 0, absStartMs: 0, durMs: 30_000 },
    ]);
    expect(plans[1]!.pieces[0]).toEqual({
      reqStartMs: 0,
      absStartMs: 30_000,
      durMs: 30_000,
    });
  });

  it('never exceeds the speech cap across packed pieces', () => {
    const segments = Array.from({ length: 40 }, (_, i) => seg(i * 10, i * 10 + 5));
    const plans = packVadSegmentsForWhisper(segments, { maxSpeechSec: 30 });
    for (const p of plans) {
      expect(p.speechMs).toBeLessThanOrEqual(30_000);
      // piece offsets are a contiguous tiling of the request audio
      let expectReq = 0;
      for (const piece of p.pieces) {
        expect(piece.reqStartMs).toBe(expectReq);
        expectReq += piece.durMs;
      }
      expect(expectReq).toBe(p.speechMs);
    }
    // total speech preserved: 40 × 5 s = 200 s
    expect(plans.reduce((s, p) => s + p.speechMs, 0)).toBe(200_000);
  });

  it('empty input and degenerate spans', () => {
    expect(packVadSegmentsForWhisper([], { maxSpeechSec: 30 })).toEqual([]);
    expect(
      packVadSegmentsForWhisper(
        [{ startMs: 1000, endMs: 1000 }, { startMs: 5000, endMs: 4000 }],
        { maxSpeechSec: 30 },
      ),
    ).toEqual([]);
  });

  it('rejects invalid maxSpeechSec', () => {
    expect(() => packVadSegmentsForWhisper([], { maxSpeechSec: 0 })).toThrow();
    expect(() => packVadSegmentsForWhisper([], { maxSpeechSec: NaN })).toThrow();
  });
});
