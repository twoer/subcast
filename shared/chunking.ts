/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Map VAD speech segments to whisper-cli chunks. One entry per chunk;
 * each entry will become one `chunks` table row and one whisper-cli
 * call. Segments longer than `maxChunkSec` are sliced into consecutive
 * sub-chunks at the cap boundary — they're guaranteed to be inside a
 * speech region (the segment is the whole speech run), so the cut
 * never lands on a word.
 *
 * Pure, no I/O — exported from `shared/` so both the Nitro transcribe
 * worker and the vitest suite can use the same code path.
 */

export interface ChunkPlan {
  startMs: number;
  endMs: number;
}

export interface PlanOptions {
  /** Cap one chunk's duration; default 30 s matches whisper.cpp's sweet spot. */
  maxChunkSec: number;
}

export function planChunksFromVad(
  segments: ReadonlyArray<{ startMs: number; endMs: number }>,
  opts: PlanOptions,
): ChunkPlan[] {
  if (!Number.isFinite(opts.maxChunkSec) || opts.maxChunkSec <= 0) {
    throw new Error('maxChunkSec must be a positive finite number');
  }
  const maxMs = opts.maxChunkSec * 1000;
  const plans: ChunkPlan[] = [];
  for (const seg of segments) {
    if (seg.endMs <= seg.startMs) continue; // skip zero/negative spans defensively
    let cursor = seg.startMs;
    while (cursor < seg.endMs) {
      const end = Math.min(seg.endMs, cursor + maxMs);
      plans.push({ startMs: cursor, endMs: end });
      cursor = end;
    }
  }
  return plans;
}

/**
 * Legacy fallback chunk plan: slice an audio of total `durationSec`
 * into back-to-back chunks of `maxChunkSec` each (last chunk may be
 * short). Used when VAD is disabled in settings or when it fails at
 * runtime — preserves the original Subcast behavior bit-for-bit.
 */
export function planChunksByDuration(durationSec: number, opts: PlanOptions): ChunkPlan[] {
  if (!Number.isFinite(opts.maxChunkSec) || opts.maxChunkSec <= 0) {
    throw new Error('maxChunkSec must be a positive finite number');
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const n = Math.max(1, Math.ceil(durationSec / opts.maxChunkSec));
  const plans: ChunkPlan[] = [];
  for (let i = 0; i < n; i++) {
    plans.push({
      startMs: i * opts.maxChunkSec * 1000,
      endMs: Math.round(Math.min((i + 1) * opts.maxChunkSec, durationSec) * 1000),
    });
  }
  return plans;
}
