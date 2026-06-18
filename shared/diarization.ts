/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared types and pure helpers for speaker diarization (docs/diarization-plan.md v1.5).
 * Imported by both the Nitro server (Stage 1 / 2 pipeline) and the Nuxt
 * frontend (rendering + export).
 *
 * No I/O. No sherpa. No DB. Pure data and functions.
 */

/**
 * Stage 1 output. Raw speaker IDs are sherpa-internal integers (often
 * over-split — a 2-person video may produce 11 raw speakers). Don't show
 * these to users; the consolidation step in Stage 2 maps them to
 * semantic 'speaker_A' / 'speaker_B' / 'unknown'.
 */
export interface RawSegment {
  startMs: number;
  endMs: number;
  rawSpeaker: number;
}

/**
 * Stage 2 output. `speakerId` is the user-visible semantic label.
 * `rawSpeaker` is preserved for diagnostics and so reconsolidate
 * (changing K) can re-group without rerunning Stage 1.
 */
export interface SpeakerSegment {
  startMs: number;
  endMs: number;
  speakerId: SpeakerId;
  rawSpeaker: number;
}

/** Display-stable speaker IDs. Numeric suffix grows with K. */
export type SpeakerId = `speaker_${string}` | 'unknown';

/** Mode flag stored on diarize_tasks.mode and decided by the API caller. */
export type ConsolidateMode = 'top_k' | 'auto';

export interface ConsolidateOptions {
  /** Top-K mode: keep exactly N major speakers. Default 2. Set 0 + mode='auto' to use ratio-based detection. */
  topK?: number;
  /** Auto mode threshold: raw speakers under this ratio of total speech don't qualify as major. */
  majorSpeakerRatio?: number;
  /** Auto mode threshold: raw speakers under this absolute duration don't qualify as major. */
  minSpeakerSeconds?: number;
  /** Cosine similarity threshold for merging a non-major raw speaker into a major centroid. Below = 'unknown'. */
  mergeThreshold?: number;
  /** Defensive cap on segments per raw speaker when picking representatives for embedding. */
  maxSegmentsPerSpeaker?: number;
  /** Discard raw segments shorter than this when picking representatives. */
  minSegmentSeconds?: number;
}

export const CONSOLIDATE_DEFAULTS: Required<ConsolidateOptions> = {
  topK: 2,
  majorSpeakerRatio: 0.05,
  minSpeakerSeconds: 8,
  mergeThreshold: 0.65,
  maxSegmentsPerSpeaker: 24,
  minSegmentSeconds: 0.8,
};

export interface ConsolidatedSpeakerSummary {
  speakerId: SpeakerId;
  durationS: number;
  ratio: number;
}

export interface ConsolidatedResult {
  rawSpeakerCount: number;
  finalSpeakerCount: number;
  unknownDurationS: number;
  unknownRatio: number;
  totalSpeechS: number;
  mode: ConsolidateMode;
  topK: number;
  speakers: ConsolidatedSpeakerSummary[];
  segments: SpeakerSegment[];
  /** raw speaker → speaker_X mapping, for debugging. */
  mapping: Record<number, SpeakerId>;
}

/** Slice of speaker timeline stored on chunks.speaker_timeline JSON column. */
export interface ChunkSpeakerTimelineEntry {
  startMs: number;
  endMs: number;
  speakerId: SpeakerId;
}

/**
 * What rendering / export gets back from speakerAssign. `none` = no
 * speaker info confident enough; `single` = one dominant speaker;
 * `split` = the cue crosses speaker boundary and should be displayed
 * as N adjacent visual rows (text split by punctuation, see speakerAssign.ts).
 */
export type CueSpeakerResolution =
  | { kind: 'none' }
  | { kind: 'single'; speakerId: SpeakerId; coverageRatio: number }
  | {
      kind: 'split';
      parts: Array<{
        speakerId: SpeakerId;
        startMs: number;
        endMs: number;
        text: string;
      }>;
    };

/**
 * Smart-default view computation (Q9b, see docs/diarization-plan.md v1.5).
 *
 * Returns 'list' when grouping would be unhelpful: no diarize result,
 * single speaker, high unknown ratio (model uncertain — list with chips
 * expresses uncertainty more honestly than fake-confident groups), or
 * many speakers (groups would explode and lose density).
 *
 * Used by `useSubtitleView` composable; the user's explicit toggle
 * preference in localStorage overrides this.
 */
export interface DiarizeSummary {
  finalSpeakerCount: number;
  unknownRatio: number;
}

export function smartDefaultView(r: DiarizeSummary | null): 'list' | 'grouped' {
  if (!r) return 'list';
  if (r.finalSpeakerCount <= 1) return 'list';
  if (r.unknownRatio >= 0.15) return 'list';
  if (r.finalSpeakerCount <= 3) return 'grouped';
  return 'list';
}

/**
 * Group consecutive cues sharing a speaker into a single visual block,
 * preserving time order. Used by the grouped subtitle view.
 *
 * For cues with `kind: 'split'` (cue crosses speaker boundary), each
 * part becomes its own visual row that participates in grouping; the
 * resolution comes pre-split from `resolveCueSpeaker`.
 */
export interface RenderRow {
  cueIdx: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerId: SpeakerId | null; // null = no speaker confident enough
  /** If the cue was split, which part of the original cue this row represents. */
  partIdx?: number;
}

export interface SpeakerGroup {
  speakerId: SpeakerId | null;
  startMs: number;
  endMs: number;
  rows: RenderRow[];
}

export function groupCuesBySpeaker(rows: readonly RenderRow[]): SpeakerGroup[] {
  const groups: SpeakerGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.speakerId === row.speakerId) {
      last.rows.push(row);
      last.endMs = row.endMs;
    } else {
      groups.push({
        speakerId: row.speakerId,
        startMs: row.startMs,
        endMs: row.endMs,
        rows: [row],
      });
    }
  }
  return groups;
}

/**
 * Stable color index for a speaker. Maps semantic IDs to HSL ring
 * positions based on appearance order, not the underlying letter — so
 * after a merge/rerun where IDs renumber, colors don't jump around.
 *
 * Pass `appearanceOrder` = the sorted list of speakerIds actually
 * present in this video (typically by total duration desc). Returns
 * the index into that list, which UI code multiplies by ~137° (golden
 * angle) for hue.
 */
export function speakerColorIndex(
  speakerId: SpeakerId,
  appearanceOrder: readonly SpeakerId[],
): number {
  if (speakerId === 'unknown') return -1;
  const idx = appearanceOrder.indexOf(speakerId);
  return idx < 0 ? 0 : idx;
}
