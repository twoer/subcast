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

/**
 * One speech run packed gaplessly into a whisper request. The request
 * audio is the CONCATENATION of `pieces` (silence between VAD segments
 * excluded), so `reqStartMs` → `absStartMs` maps request-local cue
 * timestamps back to absolute media time.
 */
export interface PackedPiece {
  /** Offset of this piece inside the packed request audio (ms). */
  reqStartMs: number;
  /** Absolute start in the source media (ms). */
  absStartMs: number;
  durMs: number;
}

/** A whisper chunk plan built from several concatenated VAD segments. */
export interface PackedChunkPlan {
  /** Absolute span (first piece start → last piece end) — display/progress only. */
  startMs: number;
  endMs: number;
  /** Total speech = sum of piece durations (excludes inter-segment silence). */
  speechMs: number;
  pieces: PackedPiece[];
}

/**
 * Pack VAD speech segments into gapless whisper requests of at most
 * `maxSpeechSec` of actual speech each. Feeding whisper concatenated
 * speech (instead of one request per tiny VAD segment) removes the
 * per-request floor — whisper pads every request to its 30 s mel
 * window, so 300 × 2 s fragments cost 300 full windows plus HTTP and
 * parse overhead, while the same audio packs into ~20 dense requests.
 * The speech-only property of the VAD design is preserved (no silence
 * is reintroduced), so the hallucination profile is unchanged.
 *
 * Segments longer than the cap are split at the cap like
 * `planChunksFromVad`. Pure and deterministic, so resume replays the
 * same packing.
 */
export function packVadSegmentsForWhisper(
  segments: ReadonlyArray<{ startMs: number; endMs: number }>,
  opts: { maxSpeechSec: number },
): PackedChunkPlan[] {
  if (!Number.isFinite(opts.maxSpeechSec) || opts.maxSpeechSec <= 0) {
    throw new Error('maxSpeechSec must be a positive finite number');
  }
  const maxMs = opts.maxSpeechSec * 1000;
  const plans: PackedChunkPlan[] = [];
  let pieces: PackedPiece[] = [];
  let speechMs = 0;
  const flush = (): void => {
    if (pieces.length === 0) return;
    const last = pieces[pieces.length - 1]!;
    plans.push({
      startMs: pieces[0]!.absStartMs,
      endMs: last.absStartMs + last.durMs,
      speechMs,
      pieces,
    });
    pieces = [];
    speechMs = 0;
  };
  for (const seg of segments) {
    if (seg.endMs <= seg.startMs) continue; // skip zero/negative spans defensively
    let cursor = seg.startMs;
    while (cursor < seg.endMs) {
      const end = Math.min(seg.endMs, cursor + maxMs);
      const durMs = end - cursor;
      if (speechMs > 0 && speechMs + durMs > maxMs) flush();
      pieces.push({ reqStartMs: speechMs, absStartMs: cursor, durMs });
      speechMs += durMs;
      cursor = end;
    }
  }
  flush();
  return plans;
}
