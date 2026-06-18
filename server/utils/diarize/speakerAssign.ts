/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Cue ↔ speaker projection (docs/diarization-plan.md v1.5 §二, Q3 + Q4).
 *
 * The diarization timeline (`SpeakerSegment[]`) and Whisper's cue
 * timeline (`Cue[]`) are produced independently and don't align —
 * a whisper cue can sit inside a single speaker turn, span two speakers'
 * back-and-forth, or fall entirely in non-speech (e.g., Whisper picked
 * up faint music). This module decides what UI/export should do with
 * each cue.
 *
 * Pure functions, no I/O. Called at render time by the player and at
 * export time by `serializeVtt` / `serializeSrt`. Storage (cues_json)
 * is never mutated (Q4: cue splitting lives in the view layer).
 */

import type { Cue } from '../vtt';
import type {
  CueSpeakerResolution,
  ChunkSpeakerTimelineEntry,
  SpeakerId,
} from '#shared/diarization';

/**
 * Q3 decision: occupancy ratio denominator is always `cue.endMs -
 * cue.startMs`. The 5 s cue with 0.5 s of speaker A + 0.5 s of speaker
 * B + 4 s of silence has total speaker coverage 1 s / 5 s = 20%, which
 * (correctly) falls below the 30% floor and is resolved to `none` —
 * not split into two illusory speakers each of whom only "spoke" 10%
 * of the cue.
 */
const NONE_RATIO_FLOOR = 0.3;
const SINGLE_DOMINANT_FLOOR = 0.7;
const SPLIT_MIN_RATIO = 0.25;

/**
 * Decide what the player / exporter should do with a single cue given
 * the speaker timeline. Three outcomes per Q3 rules:
 *
 *   - `none`:    speaker coverage < 30% of cue → no speaker label
 *   - `single`:  one speaker covers ≥ 70%, or dominant ≥ 70% even with
 *                a minor second speaker → one label
 *   - `split`:   ≥ 2 speakers each cover ≥ 25% → split visually
 *
 * `timeline` should be the slice of `ChunkSpeakerTimelineEntry[]`
 * relevant to this cue's chunk (filtering globally per cue is wasteful;
 * the caller already knows which chunk owns the cue).
 */
export function resolveCueSpeaker(
  cue: Cue,
  timeline: readonly ChunkSpeakerTimelineEntry[],
): CueSpeakerResolution {
  const cueDurationMs = cue.endMs - cue.startMs;
  if (cueDurationMs <= 0) return { kind: 'none' };

  // Sum coverage per speaker. We also keep individual overlap entries
  // so cue-splitting (the 'split' branch) can chronologically locate
  // each speaker's portion inside the cue.
  const overlapsByspeaker = new Map<SpeakerId, Array<{ startMs: number; endMs: number }>>();
  let totalOverlapMs = 0;

  for (const seg of timeline) {
    const overlapStart = Math.max(cue.startMs, seg.startMs);
    const overlapEnd = Math.min(cue.endMs, seg.endMs);
    if (overlapEnd <= overlapStart) continue;

    const arr = overlapsByspeaker.get(seg.speakerId) ?? [];
    arr.push({ startMs: overlapStart, endMs: overlapEnd });
    overlapsByspeaker.set(seg.speakerId, arr);
    totalOverlapMs += overlapEnd - overlapStart;
  }

  const totalCoverage = totalOverlapMs / cueDurationMs;
  if (totalCoverage < NONE_RATIO_FLOOR) return { kind: 'none' };

  // Per-speaker ratios.
  const perSpeakerMs = new Map<SpeakerId, number>();
  for (const [speakerId, overlaps] of overlapsByspeaker) {
    let sum = 0;
    for (const o of overlaps) sum += o.endMs - o.startMs;
    perSpeakerMs.set(speakerId, sum);
  }
  const perSpeakerRatios = new Map<SpeakerId, number>();
  for (const [speakerId, ms] of perSpeakerMs) {
    perSpeakerRatios.set(speakerId, ms / cueDurationMs);
  }

  // Dominant speaker first (highest ratio).
  const sorted = [...perSpeakerRatios].sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0]!;

  // 'single' if dominant alone ≥ 70%.
  if (dominant[1] >= SINGLE_DOMINANT_FLOOR) {
    return { kind: 'single', speakerId: dominant[0], coverageRatio: dominant[1] };
  }

  // 'split' if ≥ 2 speakers each ≥ 25%. Build the parts list by
  // walking the timeline chronologically inside the cue and splitting
  // text proportionally with punctuation snap.
  const qualifyingSpeakers = sorted.filter(([, r]) => r >= SPLIT_MIN_RATIO);
  if (qualifyingSpeakers.length >= 2) {
    const parts = buildSplitParts(cue, timeline);
    // Fallback to single dominant if the split machinery couldn't
    // produce a clean cut (e.g., emoji / surrogate boundary).
    if (parts) return { kind: 'split', parts };
    return { kind: 'single', speakerId: dominant[0], coverageRatio: dominant[1] };
  }

  // Otherwise: dominant in the 30%-70% grey zone — assign to dominant
  // but caller can tell from coverageRatio that confidence is lower.
  return { kind: 'single', speakerId: dominant[0], coverageRatio: dominant[1] };
}

// =============================================================================
// Cue splitting (Q4: render-time only)
// =============================================================================

// Unicode-safe punctuation set. Half-width + full-width + CJK common
// terminators. Order-independent; we just match presence at a position.
const PUNCT = new Set([
  // EN
  '.', '?', '!', ',', ';', ':',
  // CJK
  '。', '？', '！', '，', '、', '；', '：',
  // Misc
  '…', '—', '–',
]);

const PUNCT_SCAN_RADIUS = 8;

/**
 * Build the per-speaker visual rows for a 'split' cue. Returns null if
 * the text can't be cleanly cut (surrogate/emoji boundary), so the
 * caller can fall back to a single non-split row + dominant speaker.
 *
 * Strategy: walk the timeline inside the cue chronologically; for each
 * speaker turn that touches the cue, allocate a slice of the cue's
 * text proportional to that turn's duration. Snap the cut point to
 * the nearest punctuation within ±PUNCT_SCAN_RADIUS code points.
 *
 * Edge cases:
 *   - All overlaps belong to one speaker → returns null (caller should
 *     have gone the 'single' path; defensive).
 *   - Text shorter than the number of speakers → returns null.
 *   - First overlap starts after cue start → we extend the first part
 *     leftward to cover the gap.
 *   - Last overlap ends before cue end → extend rightward.
 */
interface SplitPart {
  speakerId: SpeakerId;
  startMs: number;
  endMs: number;
  text: string;
}

function buildSplitParts(
  cue: Cue,
  timeline: readonly ChunkSpeakerTimelineEntry[],
): SplitPart[] | null {
  // Get overlaps with the cue, sorted by time.
  const overlaps = timeline
    .map((seg) => ({
      speakerId: seg.speakerId,
      startMs: Math.max(cue.startMs, seg.startMs),
      endMs: Math.min(cue.endMs, seg.endMs),
    }))
    .filter((o) => o.endMs > o.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (overlaps.length < 2) return null;

  // Merge consecutive overlaps from the same speaker (timeline already
  // does this in theory, but defensive).
  const merged: typeof overlaps = [];
  for (const o of overlaps) {
    const last = merged[merged.length - 1];
    if (last && last.speakerId === o.speakerId && o.startMs <= last.endMs + 100) {
      last.endMs = Math.max(last.endMs, o.endMs);
    } else {
      merged.push({ ...o });
    }
  }
  if (merged.length < 2) return null;

  // Extend boundaries to cover the full cue.
  merged[0]!.startMs = cue.startMs;
  merged[merged.length - 1]!.endMs = cue.endMs;
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1]!;
    const cur = merged[i]!;
    // If there's a tiny gap, snap to the midpoint.
    if (cur.startMs > prev.endMs) {
      const mid = Math.round((prev.endMs + cur.startMs) / 2);
      prev.endMs = mid;
      cur.startMs = mid;
    }
  }

  // Slice text by time proportion + punctuation snap.
  // Use Array.from for codepoint-safe slicing (CJK surrogate safe).
  const chars = Array.from(cue.text);
  if (chars.length < merged.length) return null;

  const cueDurationMs = cue.endMs - cue.startMs;
  const parts: SplitPart[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const part = merged[i]!;
    const isLast = i === merged.length - 1;

    let end: number;
    if (isLast) {
      end = chars.length;
    } else {
      const proportional = Math.round(((part.endMs - cue.startMs) / cueDurationMs) * chars.length);
      end = snapToPunct(chars, proportional, cursor + 1, chars.length - 1);
    }

    if (end <= cursor) return null; // can't make progress, abort

    parts.push({
      speakerId: part.speakerId,
      startMs: part.startMs,
      endMs: part.endMs,
      text: chars.slice(cursor, end).join('').trim(),
    });
    cursor = end;
  }

  // Drop empty parts (could happen if punctuation snap collapsed two
  // adjacent slices). Below 2 means we can't render a meaningful split.
  const nonEmpty = parts.filter((p) => p.text.length > 0);
  if (nonEmpty.length < 2) return null;

  return nonEmpty;
}

/**
 * Look for a punctuation character within ±PUNCT_SCAN_RADIUS of
 * `target` in `chars`. Returns the index immediately AFTER the
 * punctuation (so the punctuation goes with the left half). If no
 * punctuation in range, return `target` unchanged. Clamped to
 * [lower, upper].
 */
function snapToPunct(
  chars: readonly string[],
  target: number,
  lower: number,
  upper: number,
): number {
  const clamp = (n: number) => Math.max(lower, Math.min(upper, n));
  target = clamp(target);
  for (let d = 0; d <= PUNCT_SCAN_RADIUS; d++) {
    const left = target - d;
    const right = target + d;
    if (left >= lower && PUNCT.has(chars[left - 1] ?? '')) return left;
    if (right <= upper && PUNCT.has(chars[right - 1] ?? '')) return right;
  }
  return target;
}
