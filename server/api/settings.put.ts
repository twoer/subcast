/* SPDX-License-Identifier: Apache-2.0 */
import { isWhisperModelName } from '#shared/whisperModels';
import type { LlmModelId } from '#shared/llmModels';
import { saveSettings, type SubcastSettings } from '../utils/settings';

const LLM_MODEL_IDS: ReadonlySet<LlmModelId> = new Set(['3b', '7b', '14b']);

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as Partial<SubcastSettings>;
  const patch: Partial<SubcastSettings> = {};

  if (body.whisperModel !== undefined) {
    if (!isWhisperModelName(body.whisperModel)) {
      throw createError({ statusCode: 400, statusMessage: 'BAD_WHISPER_MODEL' });
    }
    patch.whisperModel = body.whisperModel;
  }
  if (body.llmModel !== undefined) {
    // Accept either a valid tier id or `null` (=> clear the active model).
    if (body.llmModel === null) {
      patch.llmModel = undefined;
    } else if (typeof body.llmModel === 'string' && LLM_MODEL_IDS.has(body.llmModel as LlmModelId)) {
      patch.llmModel = body.llmModel as LlmModelId;
    } else {
      throw createError({ statusCode: 400, statusMessage: 'BAD_LLM_MODEL' });
    }
  }
  if (typeof body.cacheLimitGB === 'number' && body.cacheLimitGB > 0) {
    patch.cacheLimitGB = body.cacheLimitGB;
  }
  if (typeof body.silenceThresholdMs === 'number' && body.silenceThresholdMs >= 1000) {
    patch.silenceThresholdMs = body.silenceThresholdMs;
  }
  if (typeof body.debugMode === 'boolean') {
    patch.debugMode = body.debugMode;
  }

  const merged = saveSettings(patch);
  return { settings: merged };
});
