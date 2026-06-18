/* SPDX-License-Identifier: Apache-2.0 */
import type { BatchOptions } from '../types/batch';
import { isWhisperModelName } from '#shared/whisperModels';
import { isValidHash } from './validate';

export const BATCH_PRESETS = [
  'transcribe',
  'transcribe_translate',
  'transcribe_insights',
  'transcribe_translate_insights',
  'full',
] as const;

export type BatchPreset = typeof BATCH_PRESETS[number];

const VALID_LANG = /^[a-z]{2}(-[A-Z]{2})?$/;

export function isBatchPreset(value: unknown): value is BatchPreset {
  return typeof value === 'string' && BATCH_PRESETS.includes(value as BatchPreset);
}

export function parseBatchOptions(value: unknown): BatchOptions | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<BatchOptions>;
  if (!isWhisperModelName(raw.whisperModel)) return null;
  if (!Array.isArray(raw.targetLangs)) return null;
  if (!raw.targetLangs.every((lang) => typeof lang === 'string' && VALID_LANG.test(lang))) {
    return null;
  }
  if (typeof raw.insights !== 'boolean') return null;
  if (
    raw.insightLanguage !== undefined
    && raw.insightLanguage !== 'zh-CN'
    && raw.insightLanguage !== 'en'
  ) {
    return null;
  }
  if (typeof raw.diarize !== 'boolean') return null;
  if (raw.diarizeTopK !== undefined && (!Number.isInteger(raw.diarizeTopK) || raw.diarizeTopK < 1)) {
    return null;
  }
  return {
    whisperModel: raw.whisperModel,
    targetLangs: [...new Set(raw.targetLangs)],
    insights: raw.insights,
    insightLanguage: raw.insightLanguage,
    diarize: raw.diarize,
    diarizeTopK: raw.diarizeTopK,
  };
}

export function parseVideoShas(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const hashes = [...new Set(value)];
  if (!hashes.every((hash) => typeof hash === 'string' && isValidHash(hash))) return null;
  return hashes as string[];
}
