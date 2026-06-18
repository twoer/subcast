/* SPDX-License-Identifier: Apache-2.0 */
import type { EventEmitter } from 'node:events';

import type { Cue } from './vtt';
import type {
  InsightTaskRow,
  TranscribeTaskRow,
  TranslateTaskRow,
} from '../types/db';

/**
 * Narrow view of TranscribeTaskRow returned by ensureTask / restart flows —
 * the SELECT lists drop `created_at` / `completed_at` / `language` which the
 * consumer doesn't need.
 */
export type QueueTranscribeTaskSummary = Pick<
  TranscribeTaskRow,
  'id' | 'video_sha' | 'status' | 'model' | 'total_chunks' | 'done_chunks' | 'error_msg'
>;

/**
 * Narrow view of TranslateTaskRow returned by ensureTask / restart flows.
 * SELECT lists omit `created_at` / `completed_at`.
 */
export type QueueTranslateTaskSummary = Pick<
  TranslateTaskRow,
  'id' | 'video_sha' | 'target_lang' | 'status' | 'model' | 'progress_pct' | 'priority' | 'error_msg'
>;

export type QueueInsightTaskSummary = Pick<
  InsightTaskRow,
  'id' | 'video_sha' | 'status' | 'model' | 'ui_language' | 'error_msg'
>;

export interface QueueActiveTask {
  taskId: string;
  emitter: EventEmitter;
  abort: AbortController;
  /**
   * Resolves when `runWorker` exits (either normally, by abort, or by
   * crash). `cancelActive()` awaits this so the shutdown path can be sure
   * spawned children have been reaped before the process exits.
   */
  donePromise: Promise<void>;
}

export type QueueLLMTaskKind = 'translate' | 'insight';

export interface QueueActiveLLMTask {
  taskId: string;
  kind: QueueLLMTaskKind;
  videoSha: string;
  emitter: EventEmitter;
  abort: AbortController;
  donePromise: Promise<void>;
  // translate-specific live state (used by runTranslateWorker only).
  // TODO(post-slice-9): convert ActiveLLMTask to a discriminated union by `kind`.
  // Optional fields cover both worker types in the interim. Deferred so the
  // integration slices stay focused on plumbing.
  doneCues?: Cue[];
  lang?: string;
  model?: string;
  // insight-specific: accumulated raw token stream for late-subscriber replay.
  // Append-only inside runInsightWorker; read-only in attachInsight.
  insightRaw?: string;
}
