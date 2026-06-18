/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/diarize/[hash] — Current diarize state for a video.
 *
 * Returns the diarize_tasks row aggregates + the list of speakers
 * (with user display_names) + the per-chunk speaker_timeline arrays.
 * Frontend joins these against the cue list at render time per Q4.
 *
 * Shape lines up with what `useDiarizeStatus` composable expects on
 * the frontend.
 */

import { defineEventHandler, getRouterParam, createError } from 'h3';
import { getDb } from '../../utils/db';
import { isValidHash } from '../../utils/validate';
import type {
  ChunkSpeakerTimelineEntry,
  SpeakerId,
} from '#shared/diarization';

export default defineEventHandler((event) => {
  const hash = getRouterParam(event, 'hash');
  if (!isValidHash(hash)) throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });

  const db = getDb();

  const task = db
    .prepare(
      `SELECT status, raw_speaker_count, final_speaker_count,
              unknown_duration_s, unknown_ratio, top_k, mode,
              error_code, error_msg, created_at, completed_at
       FROM diarize_tasks WHERE video_sha = ?`,
    )
    .get(hash) as
    | {
        status: 'pending' | 'running' | 'done' | 'failed';
        raw_speaker_count: number | null;
        final_speaker_count: number | null;
        unknown_duration_s: number | null;
        unknown_ratio: number | null;
        top_k: number | null;
        mode: string | null;
        error_code: string | null;
        error_msg: string | null;
        created_at: number;
        completed_at: number | null;
      }
    | undefined;

  if (!task) {
    // Not yet diarized. Frontend handles this case by hiding the
    // toggle / showing the list view default.
    return { status: 'none' as const };
  }

  const speakers = db
    .prepare(
      `SELECT speaker_id, display_name FROM speakers
       WHERE video_sha = ? ORDER BY speaker_id`,
    )
    .all(hash) as Array<{ speaker_id: string; display_name: string | null }>;

  const timelines = db
    .prepare(
      `SELECT c.chunk_idx, c.speaker_timeline
       FROM chunks c
       JOIN transcribe_tasks t ON t.id = c.task_id
       WHERE t.video_sha = ? AND c.speaker_timeline IS NOT NULL
       ORDER BY c.start_ms`,
    )
    .all(hash) as Array<{ chunk_idx: number; speaker_timeline: string }>;

  const timeline: ChunkSpeakerTimelineEntry[] = [];
  for (const row of timelines) {
    const entries = JSON.parse(row.speaker_timeline) as ChunkSpeakerTimelineEntry[];
    for (const e of entries) timeline.push(e);
  }

  return {
    status: task.status,
    rawSpeakerCount: task.raw_speaker_count,
    finalSpeakerCount: task.final_speaker_count,
    unknownDurationS: task.unknown_duration_s,
    unknownRatio: task.unknown_ratio,
    topK: task.top_k,
    mode: task.mode as 'top_k' | 'auto' | null,
    errorCode: task.error_code,
    errorMsg: task.error_msg,
    speakers: speakers.map((s) => ({
      speakerId: s.speaker_id as SpeakerId,
      displayName: s.display_name,
    })),
    timeline,
  };
});
