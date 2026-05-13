/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * LLM (Qwen 2.5) model catalog.
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
 * sha256 left undefined for now — see whisperConfig.ts for the same
 * rationale (downloader skips verification gracefully when undefined).
 */

export type LlmModelId = '3b' | '7b' | '14b';
export type LlmMirror = 'huggingface' | 'hf-mirror';

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

const MIRROR_PREFIX: Record<LlmMirror, (id: LlmModelId) => string> = {
  huggingface: (id) => `https://huggingface.co/bartowski/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
  'hf-mirror': (id) => `https://hf-mirror.com/bartowski/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
};

function idCase(id: LlmModelId): string {
  return id.toUpperCase();
}

export function llmDownloadUrl(id: LlmModelId, mirror: LlmMirror): string {
  return `${MIRROR_PREFIX[mirror](id)}/${LLM_MODELS[id].filename}`;
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
