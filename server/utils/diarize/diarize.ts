/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Main entry point for the diarization pipeline (docs/diarization-plan.md v1.5).
 *
 * Two top-level operations:
 *
 *   runDiarize(videoSha) — full Stage 1 + Stage 2 run. Extracts WAV
 *     (or reuses if already there), calls sherpa, computes per-raw-
 *     speaker centroids, persists them, runs consolidation, writes
 *     the chunk-sliced speaker_timeline back to chunks, updates the
 *     diarize_tasks row. Takes ~5-7 min on a 1 h video.
 *
 *   reconsolidate(videoSha, opts) — Stage 2 only. Reads cached raw
 *     segments + centroids from SQLite, runs consolidate() with the
 *     new K, rewrites speaker_timeline. Takes ~1-2 s. This is the
 *     hot path for users tweaking K from the player UI.
 *
 * Both functions write into chunks.speaker_timeline (per Q4: cues_json
 * stays untouched) and update diarize_tasks aggregates so the warning
 * ribbon / view smart-default have what they need.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../db';
import { extractWav } from '../whisper';
import { logEvent } from '../log';
import { runRawDiarization } from './rawDiarization';
import { consolidate } from './consolidate';
import type {
  ConsolidateOptions,
  ConsolidatedResult,
  ChunkSpeakerTimelineEntry,
  RawSegment,
} from '#shared/diarization';
import type Database from 'better-sqlite3';

class DiarizeTaskCanceledError extends Error {
  constructor(taskId: string) {
    super(`diarize task canceled: ${taskId}`);
    this.name = 'DiarizeTaskCanceledError';
  }
}

/**
 * Result returned to API callers / SSE frames. Mirrors the
 * diagnostics block of user TECHNICAL_PLAN.md's output contract.
 */
export interface DiarizeResult {
  videoSha: string;
  rawSpeakerCount: number;
  finalSpeakerCount: number;
  unknownDurationS: number;
  unknownRatio: number;
  topK: number;
  mode: 'top_k' | 'auto';
  speakers: ConsolidatedResult['speakers'];
}

export interface RunDiarizeOptions extends ConsolidateOptions {
  /** Override videoPath; otherwise resolved from SQLite. */
  videoPath?: string;
}

/**
 * Stage 1 + Stage 2. Throws on missing video / model / corrupted wav.
 */
export async function runDiarize(
  videoSha: string,
  taskId: string,
  opts: RunDiarizeOptions = {},
): Promise<DiarizeResult> {
  const db = getDb();
  markTaskStatus(db, taskId, 'running');

  const videoPath = opts.videoPath ?? resolveVideoPath(db, videoSha);
  const wavPath = join(SUBCAST_PATHS.cache, videoSha, 'audio.16k-mono.wav');

  // The cache subdir may not exist yet for a freshly-transcribed video
  // (transcribe writes its wav to SUBCAST_PATHS.tmp, not cache). Create
  // before ffmpeg gets the path or extractWav errors with ENOENT.
  mkdirSync(dirname(wavPath), { recursive: true });

  // Reuse extractWav from the transcribe pipeline. extractWav writes
  // 16 kHz mono s16le wav, which is exactly what sherpa expects.
  // Idempotent — ffmpeg uses `-y` to overwrite if the wav is already there.
  await extractWav(videoPath, wavPath);

  const raw = await runRawDiarization(wavPath, {
    maxSegmentsPerSpeaker: opts.maxSegmentsPerSpeaker,
    minSegmentSeconds: opts.minSegmentSeconds,
  });

  logEvent({
    level: 'info',
    event: 'diarize_stage1_done',
    videoSha,
    rawSegments: raw.rawSegments.length,
    rawSpeakers: raw.rawSpeakers.length,
    processMs: raw.processMs,
    embeddingMs: raw.embeddingMs,
  });

  assertTaskStillRunning(db, taskId);

  // Persist Stage 1 output: centroids (own table) + raw segments (per-chunk
  // JSON column on chunks). Both survive past Stage 2 so reconsolidate can
  // rerun Stage 2 without rerunning sherpa.
  persistRawSpeakers(db, videoSha, raw.rawSpeakers);
  writeRawSpeakerTimeline(db, videoSha, raw.rawSegments);

  // Stage 2.
  const result = consolidate(raw.rawSegments, raw.rawSpeakers, opts);
  db.transaction(() => {
    assertTaskStillRunning(db, taskId);
    writeSpeakerTimeline(db, videoSha, result.segments);
    registerSpeakers(db, videoSha, result.speakers.map((s) => s.speakerId));
    updateTaskAggregates(db, taskId, result);
    markTaskStatus(db, taskId, 'done');
    setHasDiarization(db, videoSha, true);
  })();

  logEvent({
    level: 'info',
    event: 'diarize_done',
    videoSha,
    rawSpeakerCount: result.rawSpeakerCount,
    finalSpeakerCount: result.finalSpeakerCount,
    unknownRatio: result.unknownRatio,
    topK: result.topK,
  });

  return toApiResult(videoSha, result);
}

/**
 * Stage 2 only. Reads cached raw_segments (folded back from
 * chunks.speaker_timeline or — if we ever add a raw_segments column —
 * from there) and centroids. Doesn't touch sherpa.
 */
export function reconsolidate(
  videoSha: string,
  opts: ConsolidateOptions = {},
): DiarizeResult {
  const db = getDb();

  const rawSegments = loadRawSegments(db, videoSha);
  const rawSpeakers = loadRawSpeakers(db, videoSha);
  if (rawSpeakers.length === 0) {
    throw new Error(
      `reconsolidate: no cached raw speakers for ${videoSha}; run runDiarize first`,
    );
  }

  const result = consolidate(rawSegments, rawSpeakers, opts);
  writeSpeakerTimeline(db, videoSha, result.segments);
  registerSpeakers(db, videoSha, result.speakers.map((s) => s.speakerId));

  // Update task aggregates inline (no status change — it's still 'done').
  const taskId = getTaskId(db, videoSha);
  if (taskId) updateTaskAggregates(db, taskId, result);

  logEvent({
    level: 'info',
    event: 'diarize_reconsolidated',
    videoSha,
    finalSpeakerCount: result.finalSpeakerCount,
    unknownRatio: result.unknownRatio,
    topK: result.topK,
  });

  return toApiResult(videoSha, result);
}

// =============================================================================
// SQLite helpers
// =============================================================================

function resolveVideoPath(db: Database.Database, videoSha: string): string {
  const row = db
    .prepare('SELECT ext FROM videos WHERE sha256 = ?')
    .get(videoSha) as { ext: string } | undefined;
  if (!row) throw new Error(`video not found: ${videoSha}`);
  return join(SUBCAST_PATHS.videos, `${videoSha}${row.ext}`);
}

function markTaskStatus(
  db: Database.Database,
  taskId: string,
  status: 'pending' | 'running' | 'done' | 'failed',
): void {
  const completedAt = status === 'done' || status === 'failed' ? Date.now() : null;
  db.prepare(
    `UPDATE diarize_tasks SET status = ?, completed_at = ? WHERE id = ?`,
  ).run(status, completedAt, taskId);
}

function assertTaskStillRunning(db: Database.Database, taskId: string): void {
  const row = db
    .prepare(`SELECT status FROM diarize_tasks WHERE id = ?`)
    .get(taskId) as { status: string } | undefined;
  if (row?.status !== 'running') {
    throw new DiarizeTaskCanceledError(taskId);
  }
}

function setHasDiarization(db: Database.Database, videoSha: string, value: boolean): void {
  db.prepare('UPDATE videos SET has_diarization = ? WHERE sha256 = ?').run(value ? 1 : 0, videoSha);
}

function getTaskId(db: Database.Database, videoSha: string): string | null {
  const row = db
    .prepare('SELECT id FROM diarize_tasks WHERE video_sha = ?')
    .get(videoSha) as { id: string } | undefined;
  return row?.id ?? null;
}

function persistRawSpeakers(
  db: Database.Database,
  videoSha: string,
  rawSpeakers: ReadonlyArray<{
    rawSpeaker: number;
    durationS: number;
    segmentCount: number;
    centroid: Float32Array;
  }>,
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM diarize_raw_speakers WHERE video_sha = ?').run(videoSha);
    const insert = db.prepare(
      'INSERT INTO diarize_raw_speakers (video_sha, raw_speaker, duration_s, segment_count, centroid_emb) VALUES (?, ?, ?, ?, ?)',
    );
    for (const rs of rawSpeakers) {
      const buf = Buffer.from(rs.centroid.buffer, rs.centroid.byteOffset, rs.centroid.byteLength);
      insert.run(videoSha, rs.rawSpeaker, rs.durationS, rs.segmentCount, buf);
    }
  });
  tx();
}

function loadRawSpeakers(
  db: Database.Database,
  videoSha: string,
): Array<{ rawSpeaker: number; durationS: number; segmentCount: number; centroid: Float32Array }> {
  const rows = db
    .prepare(
      'SELECT raw_speaker, duration_s, segment_count, centroid_emb FROM diarize_raw_speakers WHERE video_sha = ?',
    )
    .all(videoSha) as Array<{
    raw_speaker: number;
    duration_s: number;
    segment_count: number;
    centroid_emb: Buffer;
  }>;
  return rows.map((r) => ({
    rawSpeaker: r.raw_speaker,
    durationS: r.duration_s,
    segmentCount: r.segment_count,
    centroid: new Float32Array(
      r.centroid_emb.buffer,
      r.centroid_emb.byteOffset,
      r.centroid_emb.byteLength / 4,
    ).slice(), // copy out of the SQLite-owned buffer
  }));
}

/**
 * Slice the consolidated SpeakerSegment[] into per-chunk timelines
 * (each chunk gets the segments that overlap its time window) and
 * write to chunks.speaker_timeline.
 *
 * Per Q4: cues_json never changes; this column is the only place
 * speaker info lives in storage.
 */
function writeSpeakerTimeline(
  db: Database.Database,
  videoSha: string,
  finalSegments: ConsolidatedResult['segments'],
): void {
  const chunks = db
    .prepare(
      `SELECT c.task_id, c.chunk_idx, c.start_ms, c.end_ms
       FROM chunks c
       JOIN transcribe_tasks t ON t.id = c.task_id
       WHERE t.video_sha = ?
       ORDER BY c.start_ms`,
    )
    .all(videoSha) as Array<{
    task_id: string;
    chunk_idx: number;
    start_ms: number;
    end_ms: number;
  }>;

  const tx = db.transaction(() => {
    const update = db.prepare(
      'UPDATE chunks SET speaker_timeline = ? WHERE task_id = ? AND chunk_idx = ?',
    );
    for (const ch of chunks) {
      const entries: ChunkSpeakerTimelineEntry[] = [];
      for (const seg of finalSegments) {
        const start = Math.max(seg.startMs, ch.start_ms);
        const end = Math.min(seg.endMs, ch.end_ms);
        if (end > start) entries.push({ startMs: start, endMs: end, speakerId: seg.speakerId });
      }
      update.run(JSON.stringify(entries), ch.task_id, ch.chunk_idx);
    }
  });
  tx();
}

/**
 * Persist Stage 1 raw segments to chunks.raw_speaker_timeline. Same
 * per-chunk sliced JSON pattern as writeSpeakerTimeline, just keeping
 * the rawSpeaker integer instead of the semantic speakerId. Needed so
 * reconsolidate can rerun Stage 2 without rerunning sherpa.
 */
function writeRawSpeakerTimeline(
  db: Database.Database,
  videoSha: string,
  rawSegments: readonly RawSegment[],
): void {
  const chunks = db
    .prepare(
      `SELECT c.task_id, c.chunk_idx, c.start_ms, c.end_ms
       FROM chunks c
       JOIN transcribe_tasks t ON t.id = c.task_id
       WHERE t.video_sha = ?
       ORDER BY c.start_ms`,
    )
    .all(videoSha) as Array<{
    task_id: string;
    chunk_idx: number;
    start_ms: number;
    end_ms: number;
  }>;

  const tx = db.transaction(() => {
    const update = db.prepare(
      'UPDATE chunks SET raw_speaker_timeline = ? WHERE task_id = ? AND chunk_idx = ?',
    );
    for (const ch of chunks) {
      const entries: Array<{ startMs: number; endMs: number; rawSpeaker: number }> = [];
      for (const seg of rawSegments) {
        const start = Math.max(seg.startMs, ch.start_ms);
        const end = Math.min(seg.endMs, ch.end_ms);
        if (end > start) entries.push({ startMs: start, endMs: end, rawSpeaker: seg.rawSpeaker });
      }
      update.run(JSON.stringify(entries), ch.task_id, ch.chunk_idx);
    }
  });
  tx();
}

/**
 * Reverse of writeRawSpeakerTimeline. Reads each chunk's
 * raw_speaker_timeline JSON, flattens to a single time-ordered
 * RawSegment[]. Re-merges adjacent overlapping slices for the same
 * rawSpeaker to undo the per-chunk slicing.
 */
function loadRawSegments(db: Database.Database, videoSha: string): RawSegment[] {
  const rows = db
    .prepare(
      `SELECT c.raw_speaker_timeline
       FROM chunks c
       JOIN transcribe_tasks t ON t.id = c.task_id
       WHERE t.video_sha = ? AND c.raw_speaker_timeline IS NOT NULL
       ORDER BY c.start_ms`,
    )
    .all(videoSha) as Array<{ raw_speaker_timeline: string }>;

  const segs: RawSegment[] = [];
  for (const row of rows) {
    const entries = JSON.parse(row.raw_speaker_timeline) as Array<{
      startMs: number;
      endMs: number;
      rawSpeaker: number;
    }>;
    for (const e of entries) segs.push(e);
  }

  // Merge slices that the chunk-cut split apart (same speaker, adjacent
  // within 100 ms or overlapping).
  segs.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: RawSegment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.rawSpeaker === s.rawSpeaker && s.startMs <= last.endMs + 100) {
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * Insert speaker rows so the rename API has something to UPDATE. Idempotent.
 */
function registerSpeakers(
  db: Database.Database,
  videoSha: string,
  speakerIds: readonly string[],
): void {
  const tx = db.transaction(() => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO speakers (video_sha, speaker_id, display_name) VALUES (?, ?, NULL)',
    );
    for (const id of speakerIds) insert.run(videoSha, id);
  });
  tx();
}

function updateTaskAggregates(
  db: Database.Database,
  taskId: string,
  result: ConsolidatedResult,
): void {
  db.prepare(
    `UPDATE diarize_tasks
     SET raw_speaker_count = ?,
         final_speaker_count = ?,
         unknown_duration_s = ?,
         unknown_ratio = ?,
         top_k = ?,
         mode = ?
     WHERE id = ?`,
  ).run(
    result.rawSpeakerCount,
    result.finalSpeakerCount,
    result.unknownDurationS,
    result.unknownRatio,
    result.topK,
    result.mode,
    taskId,
  );
}

function toApiResult(videoSha: string, result: ConsolidatedResult): DiarizeResult {
  return {
    videoSha,
    rawSpeakerCount: result.rawSpeakerCount,
    finalSpeakerCount: result.finalSpeakerCount,
    unknownDurationS: result.unknownDurationS,
    unknownRatio: result.unknownRatio,
    topK: result.topK,
    mode: result.mode,
    speakers: result.speakers,
  };
}
