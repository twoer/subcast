/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { planChunksByDuration, planChunksFromVad } from '#shared/chunking';

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
