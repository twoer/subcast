import type { Cue } from './vtt';

export type HallucinationReason = 'repeat' | 'reverse-ts' | 'density';

/**
 * Detect Whisper hallucinations per design §5 A. Pure function — see
 * server/utils/__tests__/quality.test.ts for the regression suite.
 *
 * Returns the first matching reason, or null when the chunk looks clean.
 */
export function detectHallucination(
  cues: readonly Cue[],
  chunkDurationMs: number,
): HallucinationReason | null {
  // 1) repeat: same trimmed text in 3+ consecutive cues
  let run = 1;
  for (let i = 1; i < cues.length; i++) {
    if (cues[i]!.text.trim() === cues[i - 1]!.text.trim()) {
      run += 1;
      if (run >= 3) return 'repeat';
    } else {
      run = 1;
    }
  }

  // 2) reverse-ts: any adjacent pair with decreasing startMs
  for (let i = 1; i < cues.length; i++) {
    if (cues[i]!.startMs < cues[i - 1]!.startMs) return 'reverse-ts';
  }

  // 3) density: only meaningful for chunks ≥ 10s; > 1.5 cue/sec is suspect
  if (chunkDurationMs >= 10_000) {
    const chunkSec = chunkDurationMs / 1000;
    if (cues.length / chunkSec > 1.5) return 'density';
  }

  return null;
}
