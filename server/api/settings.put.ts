/* SPDX-License-Identifier: Apache-2.0 */
import { isWhisperModelName } from '#shared/whisperModels';
import { isLlmModelId } from '#shared/llmModels';
import { saveSettings, isTranscribeEngine, isChunkingStrategy, type SubcastSettings } from '../utils/settings';

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as Partial<SubcastSettings>;
  const patch: Partial<SubcastSettings> = {};

  if (body.whisperModel !== undefined) {
    if (!isWhisperModelName(body.whisperModel)) {
      throw createError({ statusCode: 400, statusMessage: 'BAD_WHISPER_MODEL' });
    }
    patch.whisperModel = body.whisperModel;
  }
  if (body.transcribeEngine !== undefined) {
    if (!isTranscribeEngine(body.transcribeEngine)) {
      throw createError({ statusCode: 400, statusMessage: 'BAD_TRANSCRIBE_ENGINE' });
    }
    patch.transcribeEngine = body.transcribeEngine;
  }
  if (body.llmModel !== undefined) {
    // Accept either a valid tier id or `null` (=> clear the active model).
    if (body.llmModel === null) {
      patch.llmModel = undefined;
    } else if (typeof body.llmModel === 'string' && isLlmModelId(body.llmModel)) {
      patch.llmModel = body.llmModel;
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
  // ChunkingStrategy previously slipped through unvalidated here, so the
  // frontend's PUT was silently dropped — same guard as the other enums.
  if (body.chunkingStrategy !== undefined) {
    if (!isChunkingStrategy(body.chunkingStrategy)) {
      throw createError({ statusCode: 400, statusMessage: 'BAD_CHUNKING_STRATEGY' });
    }
    patch.chunkingStrategy = body.chunkingStrategy;
  }
  if (typeof body.transcriptPolish === 'boolean') {
    patch.transcriptPolish = body.transcriptPolish;
  }
  if (typeof body.polishHints === 'string') {
    patch.polishHints = body.polishHints.trim().slice(0, 500);
  }

  const merged = saveSettings(patch);
  return { settings: merged };
});
