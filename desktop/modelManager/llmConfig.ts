/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * LLM (Qwen 2.5) model catalog: download URLs across the same three mirror
 * options the Whisper side already supports (HF, hf-mirror, ModelScope),
 * expected file sizes, and a tier-based recommendation used by the wizard.
 *
 * Mirrors the architecture of `whisperConfig.ts`. The sha256 column is
 * intentionally left undefined for now — see the note in `whisperConfig.ts`
 * for the same rationale (populate at release-time from upstream blob; the
 * downloader skips verification gracefully when sha256 is undefined).
 */

export type LlmModelId = '3b' | '7b' | '14b';
export type LlmMirror = 'huggingface' | 'hf-mirror' | 'modelscope';

export interface LlmModelInfo {
  filename: string;
  sizeBytes: number;
  /** sha256 left undefined for now; populate at release-time from upstream blob. */
  sha256?: string;
  /** Minimum recommended RAM in GB. */
  minRamGB: number;
}

export const LLM_MODELS: Record<LlmModelId, LlmModelInfo> = {
  '3b':  { filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',  sizeBytes: 1_930_000_000, minRamGB: 8 },
  '7b':  { filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',  sizeBytes: 4_700_000_000, minRamGB: 16 },
  '14b': { filename: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf', sizeBytes: 9_000_000_000, minRamGB: 32 },
};

const MIRROR_PREFIX: Record<LlmMirror, (id: LlmModelId) => string> = {
  huggingface: (id) => `https://huggingface.co/Qwen/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
  'hf-mirror': (id) => `https://hf-mirror.com/Qwen/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
  modelscope:  (id) => `https://modelscope.cn/models/Qwen/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/master`,
};

function idCase(id: LlmModelId): string {
  return id.toUpperCase();
}

export function llmDownloadUrl(id: LlmModelId, mirror: LlmMirror): string {
  return `${MIRROR_PREFIX[mirror](id)}/${LLM_MODELS[id].filename.toLowerCase()}`;
}

export const RECOMMENDED_LLM_MODEL: LlmModelId = '7b';

export interface HardwareHint {
  totalMemoryGB: number;
}

export function recommendLlmModel(hw: HardwareHint): LlmModelId {
  if (hw.totalMemoryGB >= 32) return '14b';
  if (hw.totalMemoryGB >= 16) return '7b';
  return '3b';
}
