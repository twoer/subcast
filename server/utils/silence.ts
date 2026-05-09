import type { Cue } from './vtt';

export interface SilentGap {
  /** Index of the cue immediately preceding the gap (i.e. last spoken cue). */
  afterCueIdx: number;
  startMs: number;
  endMs: number;
  durationMs: number;
}

/**
 * Find inter-cue silent gaps whose duration ≥ thresholdMs. The returned gaps
 * are intended for UI insertion of "── no audio ──" markers per design §6
 * Slice 4; they do NOT modify the underlying VTT/cue stream.
 */
export function findSilentGaps(
  cues: readonly Cue[],
  thresholdMs: number,
): SilentGap[] {
  const gaps: SilentGap[] = [];
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1]!;
    const cur = cues[i]!;
    const dur = cur.startMs - prev.endMs;
    if (dur >= thresholdMs) {
      gaps.push({
        afterCueIdx: i - 1,
        startMs: prev.endMs,
        endMs: cur.startMs,
        durationMs: dur,
      });
    }
  }
  return gaps;
}
