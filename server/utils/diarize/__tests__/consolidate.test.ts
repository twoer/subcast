/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import {
  consolidate,
  cosine,
  chooseRepresentativeSegments,
  type RawSpeakerCentroid,
} from '../consolidate';
import type { RawSegment } from '#shared/diarization';

// Synthetic 4-dim "voice" vectors. Real centroids are 192-dim from
// campplus, but the algorithm is dim-agnostic so the test uses a small
// dim for readability. Each "true" speaker has a distinct basis vector;
// raw-speaker centroids are perturbations of those bases so cosine
// merge can plausibly find the right home.
const VOICE_A = new Float32Array([1, 0, 0, 0]);
const VOICE_B = new Float32Array([0, 1, 0, 0]);
const NOISE = new Float32Array([0, 0, 0.1, 1]); // far from both A and B

/** Add tiny noise to a base vector and L2-normalize. */
function perturb(base: Float32Array, noise: number): Float32Array {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = base[i]! + (Math.random() - 0.5) * noise;
  let mag = 0;
  for (let i = 0; i < out.length; i++) mag += out[i]! * out[i]!;
  mag = Math.sqrt(mag);
  for (let i = 0; i < out.length; i++) out[i]! /= mag;
  return out;
}

const seg = (startS: number, endS: number, rawSpeaker: number): RawSegment => ({
  startMs: startS * 1000,
  endMs: endS * 1000,
  rawSpeaker,
});

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosine(VOICE_A, VOICE_A)).toBeCloseTo(1, 6);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosine(VOICE_A, VOICE_B)).toBeCloseTo(0, 6);
  });
  it('returns 0 (not NaN) when one vector is all zeros', () => {
    const zero = new Float32Array([0, 0, 0, 0]);
    expect(cosine(VOICE_A, zero)).toBe(0);
  });
  it('throws on dimension mismatch', () => {
    expect(() => cosine(VOICE_A, new Float32Array([1, 2]))).toThrow(/dim mismatch/);
  });
});

describe('chooseRepresentativeSegments', () => {
  it('picks longest segments up to maxSegments, ordered by start time', () => {
    const segs = [
      { startMs: 0, endMs: 1000 }, // 1s
      { startMs: 2000, endMs: 10_000 }, // 8s ← longest
      { startMs: 12_000, endMs: 14_000 }, // 2s
      { startMs: 15_000, endMs: 19_000 }, // 4s
    ];
    const out = chooseRepresentativeSegments(segs, 2, 0.5);
    // Should pick the 8s and 4s, then sort by startMs.
    expect(out).toEqual([
      { startMs: 2000, endMs: 10_000 },
      { startMs: 15_000, endMs: 19_000 },
    ]);
  });
  it('drops segments below minSeconds', () => {
    const segs = [
      { startMs: 0, endMs: 200 }, // 0.2s — below 0.8s threshold
      { startMs: 1000, endMs: 5000 }, // 4s — passes
    ];
    const out = chooseRepresentativeSegments(segs, 10, 0.8);
    expect(out).toHaveLength(1);
  });
});

describe('consolidate — Top-K mode', () => {
  it('two clear speakers + one merge-able variant → 2 final speakers, no unknown', () => {
    // Setup: 3 raw speakers. Raw 0 = base voice A; raw 1 = base voice B;
    // raw 2 = perturbation of A (cosine ~0.99 to A's centroid).
    const segments: RawSegment[] = [
      seg(0, 30, 0), // A speaks 30s
      seg(30, 50, 1), // B speaks 20s
      seg(50, 55, 2), // "A variant" speaks 5s
      seg(55, 80, 0), // A again 25s
    ];
    const centroids: RawSpeakerCentroid[] = [
      { rawSpeaker: 0, durationS: 55, segmentCount: 2, centroid: VOICE_A },
      { rawSpeaker: 1, durationS: 20, segmentCount: 1, centroid: VOICE_B },
      { rawSpeaker: 2, durationS: 5, segmentCount: 1, centroid: perturb(VOICE_A, 0.05) },
    ];

    const r = consolidate(segments, centroids, { topK: 2, mergeThreshold: 0.5 });

    expect(r.finalSpeakerCount).toBe(2);
    expect(r.unknownDurationS).toBe(0);
    expect(r.rawSpeakerCount).toBe(3);
    expect(r.mode).toBe('top_k');

    // Speaker_A should be the longest-speaking — raw 0.
    expect(r.mapping[0]).toBe('speaker_A');
    expect(r.mapping[1]).toBe('speaker_B');
    expect(r.mapping[2]).toBe('speaker_A'); // merged via cosine

    // Final segments retain rawSpeaker for traceability.
    expect(r.segments[2]).toMatchObject({ rawSpeaker: 2, speakerId: 'speaker_A' });

    // Ratios sum to ~1 (segments overlap minimally so we just sanity check).
    const totalRatio = r.speakers.reduce((s, sp) => s + sp.ratio, 0);
    expect(totalRatio).toBeCloseTo(1, 2);
  });

  it('orthogonal third speaker below mergeThreshold → unknown', () => {
    const segments: RawSegment[] = [
      seg(0, 60, 0), // A 60s
      seg(60, 120, 1), // B 60s
      seg(120, 125, 2), // noise 5s
    ];
    const centroids: RawSpeakerCentroid[] = [
      { rawSpeaker: 0, durationS: 60, segmentCount: 1, centroid: VOICE_A },
      { rawSpeaker: 1, durationS: 60, segmentCount: 1, centroid: VOICE_B },
      { rawSpeaker: 2, durationS: 5, segmentCount: 1, centroid: NOISE },
    ];

    const r = consolidate(segments, centroids, { topK: 2, mergeThreshold: 0.65 });

    expect(r.finalSpeakerCount).toBe(2);
    expect(r.mapping[2]).toBe('unknown');
    expect(r.unknownDurationS).toBeCloseTo(5, 5);
    expect(r.unknownRatio).toBeCloseTo(5 / 125, 4);
  });

  it('topK > rawSpeakers → all become majors, no unknown', () => {
    const segments: RawSegment[] = [seg(0, 60, 0), seg(60, 120, 1)];
    const centroids: RawSpeakerCentroid[] = [
      { rawSpeaker: 0, durationS: 60, segmentCount: 1, centroid: VOICE_A },
      { rawSpeaker: 1, durationS: 60, segmentCount: 1, centroid: VOICE_B },
    ];

    const r = consolidate(segments, centroids, { topK: 5 });

    expect(r.finalSpeakerCount).toBe(2);
    expect(r.unknownDurationS).toBe(0);
  });

  it('speakers sorted by duration desc; speaker_A always the longest', () => {
    // Raw 1 has more speech time than raw 0.
    const segments: RawSegment[] = [
      seg(0, 10, 0), // raw 0 — 10s
      seg(10, 100, 1), // raw 1 — 90s
    ];
    const centroids: RawSpeakerCentroid[] = [
      { rawSpeaker: 0, durationS: 10, segmentCount: 1, centroid: VOICE_A },
      { rawSpeaker: 1, durationS: 90, segmentCount: 1, centroid: VOICE_B },
    ];

    const r = consolidate(segments, centroids, { topK: 2 });

    expect(r.mapping[1]).toBe('speaker_A');
    expect(r.mapping[0]).toBe('speaker_B');
    expect(r.speakers[0]!.speakerId).toBe('speaker_A');
    expect(r.speakers[0]!.durationS).toBe(90);
  });
});

describe('consolidate — Auto mode', () => {
  it('ratio-based filter passes only speakers above thresholds', () => {
    const segments: RawSegment[] = [
      seg(0, 100, 0), // 100s — clear major
      seg(100, 110, 1), // 10s — passes minSpeakerSeconds=8 + ratio>=0.05
      seg(110, 113, 2), // 3s — below both thresholds → unknown
    ];
    const centroids: RawSpeakerCentroid[] = [
      { rawSpeaker: 0, durationS: 100, segmentCount: 1, centroid: VOICE_A },
      { rawSpeaker: 1, durationS: 10, segmentCount: 1, centroid: VOICE_B },
      { rawSpeaker: 2, durationS: 3, segmentCount: 1, centroid: NOISE },
    ];

    const r = consolidate(segments, centroids, {
      topK: 0,
      majorSpeakerRatio: 0.05,
      minSpeakerSeconds: 8,
      mergeThreshold: 0.65,
    });

    expect(r.mode).toBe('auto');
    expect(r.finalSpeakerCount).toBe(2);
    expect(r.mapping[2]).toBe('unknown');
  });

  it('falls back to longest raw speaker when nobody meets thresholds', () => {
    // No raw speaker meets minSpeakerSeconds=100 — but we should still
    // produce at least one major (the longest) instead of all unknown.
    const segments: RawSegment[] = [seg(0, 30, 0), seg(30, 50, 1)];
    const centroids: RawSpeakerCentroid[] = [
      { rawSpeaker: 0, durationS: 30, segmentCount: 1, centroid: VOICE_A },
      { rawSpeaker: 1, durationS: 20, segmentCount: 1, centroid: VOICE_B },
    ];

    const r = consolidate(segments, centroids, {
      topK: 0,
      minSpeakerSeconds: 100, // unrealistic, forces fallback
      mergeThreshold: 0.65,
    });

    expect(r.finalSpeakerCount).toBe(1);
    expect(r.mapping[0]).toBe('speaker_A'); // longest
    expect(r.mapping[1]).toBe('unknown'); // orthogonal, below merge threshold
  });
});

describe('consolidate — degenerate cases', () => {
  it('empty centroids → everything unknown, finalSpeakerCount 0', () => {
    const segments: RawSegment[] = [seg(0, 30, 0)];
    const r = consolidate(segments, [], { topK: 2 });

    expect(r.finalSpeakerCount).toBe(0);
    expect(r.unknownDurationS).toBeCloseTo(30, 5);
    expect(r.unknownRatio).toBe(1);
    expect(r.segments[0]!.speakerId).toBe('unknown');
  });

  it('empty segments → 0 / 0 result without throwing', () => {
    const r = consolidate([], [], { topK: 2 });
    expect(r.finalSpeakerCount).toBe(0);
    expect(r.totalSpeechS).toBe(0);
    expect(r.unknownRatio).toBe(0);
  });

  it('25-min two-speaker scenario (matches user TECHNICAL_PLAN ground truth)', () => {
    // Synthesize an 11-raw-speaker, 25-min video where two raw speakers
    // dominate and the other 9 are noise / very short. Reproduce the
    // approximate shape from user's RESULTS: speaker_A ~ 56%, speaker_B
    // ~ 42%, unknown ~ 2%.
    const segments: RawSegment[] = [];
    const centroids: RawSpeakerCentroid[] = [];

    // Two main speakers, each takes a big chunk of speech.
    segments.push(seg(0, 421.3, 0));
    centroids.push({ rawSpeaker: 0, durationS: 421.3, segmentCount: 1, centroid: VOICE_A });
    segments.push(seg(421.3, 737.4, 1));
    centroids.push({ rawSpeaker: 1, durationS: 316.1, segmentCount: 1, centroid: VOICE_B });

    // 9 small fragments split between similar-to-A, similar-to-B, and orthogonal.
    let cursor = 737.4;
    for (let i = 2; i < 11; i++) {
      const dur = 16.3 / 9; // ~1.8s each — totals 16.3s like the audit
      segments.push(seg(cursor, cursor + dur, i));
      cursor += dur;
      // Orthogonal so they don't merge.
      centroids.push({ rawSpeaker: i, durationS: dur, segmentCount: 1, centroid: NOISE });
    }

    const r = consolidate(segments, centroids, { topK: 2, mergeThreshold: 0.65 });

    expect(r.rawSpeakerCount).toBe(11);
    expect(r.finalSpeakerCount).toBe(2);
    const aPct = r.speakers.find((s) => s.speakerId === 'speaker_A')!.ratio;
    const bPct = r.speakers.find((s) => s.speakerId === 'speaker_B')!.ratio;
    expect(aPct).toBeCloseTo(0.559, 2);
    expect(bPct).toBeCloseTo(0.419, 2);
    expect(r.unknownRatio).toBeCloseTo(0.022, 2);
  });
});
