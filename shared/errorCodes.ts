/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Single source of truth for task-row error codes shared between the
 * Nitro server (writes them on worker failure) and the frontend
 * (renders them via i18n on the home tasks panel + player error UI).
 *
 * Adding a new code here requires:
 *   1. A matching entry in i18n locales under `player.errors.{CODE}`
 *   2. The worker that emits it should also write it into the
 *      task row's `error_code` column so the home panel can resolve it
 *      without re-parsing the message string.
 */
export const TASK_ERROR_CODES = [
  'WHISPER_NOT_CONFIGURED',
  'MODEL_NOT_CONFIGURED',
  'ORIGINAL_NOT_READY',
  'BATCH_RETRY_EXHAUSTED',
  'PARSE_FAILED',
  'CANCELED',
  'FATAL_UNKNOWN',
] as const;

export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

const TASK_ERROR_CODE_SET: ReadonlySet<TaskErrorCode> = new Set(TASK_ERROR_CODES);

export function isTaskErrorCode(s: string | null | undefined): s is TaskErrorCode {
  return s != null && TASK_ERROR_CODE_SET.has(s as TaskErrorCode);
}

/**
 * LLM-side error markers thrown from `server/utils/llmServer.ts` and
 * surfaced through `chatStream`. Workers map any of these to the
 * `MODEL_NOT_CONFIGURED` task error code so the user gets a single
 * actionable message ("configure a model in Settings").
 */
export const LLM_ERROR_MARKERS = [
  'LLM_MODEL_NOT_CONFIGURED',
  'LLM_BINARY_MISSING',
  'MODEL_UNUSABLE',
] as const;

export function isLlmConfigError(message: string): boolean {
  return LLM_ERROR_MARKERS.some((m) => message.includes(m));
}
