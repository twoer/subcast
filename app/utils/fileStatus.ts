/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Derive per-file status from a cache entry + the recent queue snapshot.
 * Surfaced by `FileStatusBadges.vue` on the home/library rows so users can
 * see at a glance what each file is mid-processing, what failed, and what
 * downstream affordances (translate, AI insights) are usable.
 */

export interface CacheItemLike {
  sha256: string;
  langs: string[];
  hasInsights?: boolean;
  hasRunningInsight?: boolean;
}

export interface QueueItemLike {
  kind: 'transcribe' | 'translate' | 'insight' | 'diarize';
  videoSha: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'done' | 'error';
  progressPct: number;
  targetLang?: string;
  errorMsg?: string | null;
  errorCode?: string | null;
}

export interface FileStatus {
  transcribe: 'none' | 'queued' | 'running' | 'done' | 'failed';
  transcribeProgress?: number;
  transcribeError?: string | null;
  translateRunning?: { targetLang: string; progress: number };
  translateQueued?: { targetLang: string };
  translateFailed?: boolean;
  /** Count of translated subtitles (langs total minus the original). 0 if nothing transcribed yet. */
  translatedCount: number;
  insight: 'none' | 'running' | 'done';
}

export function getFileStatus(item: CacheItemLike, queue: QueueItemLike[]): FileStatus {
  const mine = queue.filter((q) => q.videoSha === item.sha256);

  // Distinguish actively-running from queued-waiting. Previously both
  // collapsed into 'running', so the video-list badge said "转写中 0%"
  // for queued tasks while the task-queue panel correctly showed "排队中"
  // — same task, two contradictory labels.
  const tRunning = mine.find((q) => q.kind === 'transcribe' && q.status === 'running');
  const tQueued = mine.find((q) => q.kind === 'transcribe' && q.status === 'queued');
  const tFailed = mine.find((q) => q.kind === 'transcribe' && q.status === 'failed');

  let transcribe: FileStatus['transcribe'] = 'none';
  let transcribeProgress: number | undefined;
  let transcribeError: string | null | undefined;
  if (tRunning) {
    transcribe = 'running';
    transcribeProgress = tRunning.progressPct;
  } else if (tQueued) {
    transcribe = 'queued';
  } else if (item.langs.length > 0) {
    // Even if the most recent task failed, we still have usable subtitles
    // from a prior run — present as 'done'. The user can retry from the
    // player if quality is off.
    transcribe = 'done';
  } else if (tFailed) {
    transcribe = 'failed';
    transcribeError = tFailed.errorMsg ?? null;
  }

  const trRunning = mine.find((q) => q.kind === 'translate' && q.status === 'running');
  const trQueued = mine.find((q) => q.kind === 'translate' && q.status === 'queued');
  const trFailed = mine.find((q) => q.kind === 'translate' && q.status === 'failed');
  const translatedCount = item.langs.length > 0 ? Math.max(0, item.langs.length - 1) : 0;

  let insight: FileStatus['insight'] = 'none';
  if (item.hasRunningInsight) insight = 'running';
  else if (item.hasInsights) insight = 'done';

  return {
    transcribe,
    transcribeProgress,
    transcribeError,
    translateRunning: trRunning
      ? { targetLang: trRunning.targetLang ?? '?', progress: trRunning.progressPct }
      : undefined,
    translateQueued: !trRunning && trQueued
      ? { targetLang: trQueued.targetLang ?? '?' }
      : undefined,
    translateFailed: !trRunning && !trQueued && !!trFailed,
    translatedCount,
    insight,
  };
}
