import { saveSettings, type SubcastSettings } from '../utils/settings';

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const;

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as Partial<SubcastSettings>;
  const patch: Partial<SubcastSettings> = {};

  if (body.whisperModel !== undefined) {
    if (!WHISPER_MODELS.includes(body.whisperModel as typeof WHISPER_MODELS[number])) {
      throw createError({ statusCode: 400, statusMessage: 'BAD_WHISPER_MODEL' });
    }
    patch.whisperModel = body.whisperModel;
  }
  if (typeof body.ollamaModel === 'string' && body.ollamaModel.length > 0) {
    patch.ollamaModel = body.ollamaModel;
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
