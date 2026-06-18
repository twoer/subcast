/* SPDX-License-Identifier: Apache-2.0 */

/**
 * LLM (Qwen 2.5) model catalog.
 *
 * Pure shared data: safe for renderer, Nitro, and Electron-side code.
 * Do not import Node, Electron, filesystem, or desktop modules here.
 *
 * **Why bartowski's repos, not Qwen's official ones**: Qwen uploads their
 * 7B+ GGUFs as multi-shard files (`-00001-of-00002.gguf` etc.) that
 * llama.cpp can load but our downloader can't (it fetches a single
 * `destPath`). `bartowski/Qwen2.5-*-Instruct-GGUF` hosts the same
 * quants as single files with stable CamelCase filenames, matching our
 * on-disk install layout 1:1. Switch repos here if the upstream
 * convention changes.
 *
 * **ModelScope dropped**: ModelScope only mirrors Qwen's official
 * (sharded) upload, not bartowski. hf-mirror.com is fast enough in
 * China that ModelScope's nice-to-have value didn't justify the
 * multi-shard download path. If we ever need a third mirror, picking
 * one that hosts bartowski's repo (or implementing shard fetch) is
 * the right move — not re-adding the Qwen-official source.
 *
 * sha256 left undefined for now — see desktop/modelManager/whisperConfig.ts
 * for the same rationale (downloader skips verification gracefully when
 * undefined).
 */

export type LlmModelId = '3b' | '7b' | '14b';
export type LlmMirror = 'huggingface' | 'hf-mirror' | 'auto';

export interface LlmModelInfo {
  filename: string;
  sizeBytes: number;
  sha256?: string;
  /** Minimum recommended RAM in GB. */
  minRamGB: number;
}

export const LLM_MODELS: Record<LlmModelId, LlmModelInfo> = {
  '3b':  { filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',  sizeBytes: 1_930_000_000, minRamGB: 8 },
  '7b':  { filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',  sizeBytes: 4_680_000_000, minRamGB: 16 },
  '14b': { filename: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf', sizeBytes: 8_990_000_000, minRamGB: 32 },
};

const MIRROR_PREFIX: Record<Exclude<LlmMirror, 'auto'>, (id: LlmModelId) => string> = {
  huggingface: (id) => `https://huggingface.co/bartowski/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
  'hf-mirror': (id) => `https://hf-mirror.com/bartowski/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
};

function idCase(id: LlmModelId): string {
  return id.toUpperCase();
}

export function llmDownloadUrl(id: LlmModelId, mirror: Exclude<LlmMirror, 'auto'>): string {
  return `${MIRROR_PREFIX[mirror](id)}/${LLM_MODELS[id].filename}`;
}

/**
 * Both candidate URLs for the given model. Used by the auto-mirror
 * race; the race picks whichever delivers bytes faster and hands the
 * winner back to `downloadFile()`.
 */
export function llmDownloadUrls(id: LlmModelId): string[] {
  return [llmDownloadUrl(id, 'huggingface'), llmDownloadUrl(id, 'hf-mirror')];
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
