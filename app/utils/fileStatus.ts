/* SPDX-License-Identifier: AGPL-3.0-or-later */

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
  kind: 'transcribe' | 'translate';
  videoSha: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  progressPct: number;
  targetLang?: string;
  errorMsg?: string | null;
}

export interface FileStatus {
  transcribe: 'none' | 'running' | 'done' | 'failed';
  transcribeProgress?: number;
  transcribeError?: string | null;
  translateRunning?: { targetLang: string; progress: number };
  translateFailed?: boolean;
  /** Count of translated subtitles (langs total minus the original). 0 if nothing transcribed yet. */
  translatedCount: number;
  insight: 'none' | 'running' | 'done';
}

function isActive(s: QueueItemLike['status']): boolean {
  return s === 'running' || s === 'queued';
}

export function getFileStatus(item: CacheItemLike, queue: QueueItemLike[]): FileStatus {
  const mine = queue.filter((q) => q.videoSha === item.sha256);

  const tActive = mine.find((q) => q.kind === 'transcribe' && isActive(q.status));
  const tFailed = mine.find((q) => q.kind === 'transcribe' && q.status === 'failed');

  let transcribe: FileStatus['transcribe'] = 'none';
  let transcribeProgress: number | undefined;
  let transcribeError: string | null | undefined;
  if (tActive) {
    transcribe = 'running';
    transcribeProgress = tActive.progressPct;
  } else if (item.langs.length > 0) {
    // Even if the most recent task failed, we still have usable subtitles
    // from a prior run — present as 'done'. The user can retry from the
    // player if quality is off.
    transcribe = 'done';
  } else if (tFailed) {
    transcribe = 'failed';
    transcribeError = tFailed.errorMsg ?? null;
  }

  const trActive = mine.find((q) => q.kind === 'translate' && isActive(q.status));
  const trFailed = mine.find((q) => q.kind === 'translate' && q.status === 'failed');
  const translatedCount = item.langs.length > 0 ? Math.max(0, item.langs.length - 1) : 0;

  let insight: FileStatus['insight'] = 'none';
  if (item.hasRunningInsight) insight = 'running';
  else if (item.hasInsights) insight = 'done';

  return {
    transcribe,
    transcribeProgress,
    transcribeError,
    translateRunning: trActive
      ? { targetLang: trActive.targetLang ?? '?', progress: trActive.progressPct }
      : undefined,
    translateFailed: !trActive && !!trFailed,
    translatedCount,
    insight,
  };
}
