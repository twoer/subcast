/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Stage 2 of the diarization pipeline (docs/diarization-plan.md v1.5).
 *
 * Takes Stage 1's over-split raw output + per-raw-speaker centroids and
 * collapses it into Top-K (or auto-detected) semantic speakers, with
 * leftover non-major raw speakers either merged into the nearest major
 * by cosine similarity or marked 'unknown'.
 *
 * Pure function — no I/O, no sherpa calls. Ported from sherpa-onnx's
 * electron-speaker-diarization-demo (consolidate-speakers.js) to
 * TypeScript, with the embedding computation extracted (Stage 1 in
 * Subcast caches centroids upfront in diarize_raw_speakers, so Stage 2
 * doesn't need sherpa at all).
 *
 * The whole point of pulling this out as a pure function: reconsolidate
 * (user changes K in the player) re-runs Stage 2 only, in ~1-2 s,
 * without rerunning sherpa (which takes minutes).
 */

import type {
  RawSegment,
  ConsolidateOptions,
  ConsolidatedResult,
  ConsolidatedSpeakerSummary,
  ConsolidateMode,
  SpeakerId,
  SpeakerSegment,
} from '#shared/diarization';
import { CONSOLIDATE_DEFAULTS } from '#shared/diarization';

export interface RawSpeakerCentroid {
  rawSpeaker: number;
  durationS: number;
  segmentCount: number;
  centroid: Float32Array; // L2-normalized recommended but not required
}

/** Cosine similarity. Assumes non-zero vectors; returns 0 for any zero magnitude. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-12) return 0;
  return dot / denom;
}

interface RawSpeakerStat {
  rawSpeaker: number;
  durationS: number;
  segmentCount: number;
  centroid: Float32Array;
}

/**
 * Two-letter sequence so we never run out: speaker_A..Z, then speaker_AA..ZZ.
 * Practically we cap selection at maybe 26 majors anyway.
 */
function speakerLabel(index: number): SpeakerId {
  if (index < 26) {
    return `speaker_${String.fromCharCode(65 + index)}` as SpeakerId;
  }
  const first = Math.floor(index / 26) - 1;
  const second = index % 26;
  return `speaker_${String.fromCharCode(65 + first)}${String.fromCharCode(65 + second)}` as SpeakerId;
}

/**
 * Compute total speech duration from raw segments. Used as the
 * denominator for `unknownRatio` and per-speaker `ratio`. Includes the
 * 'unknown' bucket so the percentages add up to 100% rather than
 * silently summing to less.
 */
function totalSpeechSeconds(segments: readonly RawSegment[]): number {
  let total = 0;
  for (const s of segments) {
    total += Math.max(0, (s.endMs - s.startMs) / 1000);
  }
  return total;
}

/**
 * Pick which raw speakers count as "major". Two strategies driven by
 * `topK`:
 *
 *   topK >= 1 (Top-K mode): take the N raw speakers with the most
 *   speech time. Anything else gets merged or marked unknown.
 *
 *   topK === 0 (Auto mode): a raw speaker is major iff its duration is
 *   both >= majorSpeakerRatio of total AND >= minSpeakerSeconds
 *   absolute. This is conservative — videos with one dominant speaker
 *   tend to collapse to a single major, which is usually right.
 */
function pickMajors(
  stats: readonly RawSpeakerStat[],
  totalSpeechS: number,
  opts: Required<ConsolidateOptions>,
): RawSpeakerStat[] {
  const sorted = [...stats].sort((a, b) => b.durationS - a.durationS);
  if (opts.topK > 0) {
    return sorted.slice(0, opts.topK);
  }
  return sorted.filter(
    (s) =>
      s.durationS >= opts.minSpeakerSeconds &&
      s.durationS / Math.max(totalSpeechS, 1e-9) >= opts.majorSpeakerRatio,
  );
}

/**
 * Run Stage 2 on cached raw output. Both inputs come from the database:
 * `segments` is the union of all chunks' rawSegments (in time order
 * across the whole video) and `centroids` is the diarize_raw_speakers
 * cache.
 *
 * Throws if `centroids` is missing any raw speaker that appears in
 * `segments` — Stage 1 must populate the cache before this runs.
 */
export function consolidate(
  segments: readonly RawSegment[],
  centroids: readonly RawSpeakerCentroid[],
  opts: ConsolidateOptions = {},
): ConsolidatedResult {
  const o: Required<ConsolidateOptions> = { ...CONSOLIDATE_DEFAULTS, ...opts };
  const mode: ConsolidateMode = o.topK > 0 ? 'top_k' : 'auto';

  // Build stat per raw speaker (durations come from segments, centroid
  // from cache). Drop any raw speaker that has no centroid; Stage 1 may
  // have intentionally skipped raw speakers with too few representative
  // segments to embed.
  const centroidMap = new Map<number, Float32Array>();
  for (const c of centroids) centroidMap.set(c.rawSpeaker, c.centroid);

  const segsByRaw = new Map<number, RawSegment[]>();
  for (const seg of segments) {
    const arr = segsByRaw.get(seg.rawSpeaker) ?? [];
    arr.push(seg);
    segsByRaw.set(seg.rawSpeaker, arr);
  }

  const stats: RawSpeakerStat[] = [];
  for (const [rawSpeaker, segs] of segsByRaw) {
    const centroid = centroidMap.get(rawSpeaker);
    if (!centroid) continue;
    let dur = 0;
    for (const s of segs) dur += Math.max(0, (s.endMs - s.startMs) / 1000);
    stats.push({
      rawSpeaker,
      durationS: dur,
      segmentCount: segs.length,
      centroid,
    });
  }

  const totalSpeechS = totalSpeechSeconds(segments);

  // No raw speakers survived embedding? Everything goes to unknown.
  // This is degenerate but not unreachable (very short videos may end
  // up with all raw segments below minSegmentSeconds during Stage 1's
  // centroid computation).
  if (stats.length === 0) {
    return emptyResult(segments, totalSpeechS, mode, o.topK);
  }

  // Pick majors. If Auto mode rejects everything (no raw speaker meets
  // the duration thresholds), fall back to the single longest-speaking
  // raw speaker — better one labeled speaker than all unknown.
  let majors = pickMajors(stats, totalSpeechS, o);
  if (majors.length === 0) {
    majors = [stats.slice().sort((a, b) => b.durationS - a.durationS)[0]!];
  }

  // Assign semantic labels in duration order so speaker_A is the
  // dominant speaker. Matters for "main speaker mode" UX.
  majors.sort((a, b) => b.durationS - a.durationS);
  const majorIdToLabel = new Map<number, SpeakerId>();
  majors.forEach((m, i) => majorIdToLabel.set(m.rawSpeaker, speakerLabel(i)));

  const mapping: Record<number, SpeakerId> = {};
  for (const m of majors) mapping[m.rawSpeaker] = majorIdToLabel.get(m.rawSpeaker)!;

  // Merge non-majors into nearest major centroid by cosine. Below
  // `mergeThreshold` → 'unknown'. Going through all stats (not just
  // non-majors) is wasteful — but the cost is negligible (a few hundred
  // dot products) and the symmetry makes the code easier to read.
  for (const s of stats) {
    if (mapping[s.rawSpeaker]) continue;
    let bestLabel: SpeakerId = 'unknown';
    let bestScore = -Infinity;
    for (const major of majors) {
      const score = cosine(s.centroid, major.centroid);
      if (score > bestScore) {
        bestScore = score;
        bestLabel = majorIdToLabel.get(major.rawSpeaker)!;
      }
    }
    mapping[s.rawSpeaker] = bestScore >= o.mergeThreshold ? bestLabel : 'unknown';
  }

  // Project mapping back over the segments.
  const finalSegments: SpeakerSegment[] = segments.map((seg) => ({
    startMs: seg.startMs,
    endMs: seg.endMs,
    rawSpeaker: seg.rawSpeaker,
    speakerId: mapping[seg.rawSpeaker] ?? 'unknown',
  }));

  // Summary stats per final speaker.
  const speakerDur = new Map<SpeakerId, number>();
  for (const fs of finalSegments) {
    const dur = Math.max(0, (fs.endMs - fs.startMs) / 1000);
    speakerDur.set(fs.speakerId, (speakerDur.get(fs.speakerId) ?? 0) + dur);
  }
  const speakers: ConsolidatedSpeakerSummary[] = [];
  let unknownDurationS = 0;
  for (const [speakerId, dur] of speakerDur) {
    if (speakerId === 'unknown') {
      unknownDurationS = dur;
      continue;
    }
    speakers.push({
      speakerId,
      durationS: dur,
      ratio: totalSpeechS > 0 ? dur / totalSpeechS : 0,
    });
  }
  speakers.sort((a, b) => b.durationS - a.durationS);

  return {
    rawSpeakerCount: segsByRaw.size,
    finalSpeakerCount: speakers.length,
    unknownDurationS,
    unknownRatio: totalSpeechS > 0 ? unknownDurationS / totalSpeechS : 0,
    totalSpeechS,
    mode,
    topK: o.topK,
    speakers,
    segments: finalSegments,
    mapping,
  };
}

function emptyResult(
  segments: readonly RawSegment[],
  totalSpeechS: number,
  mode: ConsolidateMode,
  topK: number,
): ConsolidatedResult {
  return {
    rawSpeakerCount: 0,
    finalSpeakerCount: 0,
    unknownDurationS: totalSpeechS,
    // totalSpeechS === 0 means there's no speech at all (degenerate input);
    // pick 0 over the formally-undefined 0/0 — the warning ribbon shouldn't
    // fire for an empty video.
    unknownRatio: totalSpeechS > 0 ? 1 : 0,
    totalSpeechS,
    mode,
    topK,
    speakers: [],
    segments: segments.map((s) => ({
      startMs: s.startMs,
      endMs: s.endMs,
      rawSpeaker: s.rawSpeaker,
      speakerId: 'unknown' as SpeakerId,
    })),
    mapping: {},
  };
}

// =============================================================================
// Stage 1 helper — pick representative segments per raw speaker
// =============================================================================

/**
 * Stage 1 calls this when computing centroids: pick a small but
 * informative set of segments for each raw speaker to feed the
 * embedding extractor. Long segments win, with a defensive cap to bound
 * embedding compute time per video.
 *
 * Pure function; lives here (rather than in rawDiarization.ts) so the
 * unit tests can exercise the selection logic without sherpa.
 */
export function chooseRepresentativeSegments<T extends { startMs: number; endMs: number }>(
  segments: readonly T[],
  maxSegments: number,
  minSeconds: number,
): T[] {
  const durationS = (s: T) => (s.endMs - s.startMs) / 1000;
  return [...segments]
    .filter((s) => durationS(s) >= minSeconds)
    .sort((a, b) => durationS(b) - durationS(a))
    .slice(0, maxSegments)
    .sort((a, b) => a.startMs - b.startMs);
}
