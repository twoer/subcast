/* SPDX-License-Identifier: Apache-2.0 */

/**
 * LLM (Qwen 3) model catalog.
 *
 * Pure shared data: safe for renderer, Nitro, and Electron-side code.
 * Do not import Node, Electron, filesystem, or desktop modules here.
 *
 * **Why Qwen's official repos (not bartowski)**: the historical reason for
 * bartowski was that Qwen uploaded 7B+ GGUFs as multi-shard files our
 * single-file downloader can't fetch. Qwen3 official GGUF repos ship each
 * quant as a single file, so the extra mirror layer is no longer needed.
 * If Qwen ever returns to sharded uploads, bartowski's `Qwen_Qwen3-*-GGUF`
 * repos are the drop-in fallback (single files, stable names).
 *
 * **Thinking mode**: Qwen3 emits `<think>` reasoning by default. The llama
 * server request path disables it via `chat_template_kwargs` and the
 * backend strips any leaked `<think>` blocks — see
 * `server/utils/llmBackendLlamaServer.ts`. Nothing prompt-side.
 *
 * sha256 left undefined for now — see desktop/modelManager/whisperConfig.ts
 * for the same rationale (downloader skips verification gracefully when
 * undefined).
 */

export type LlmModelId = '4b' | '8b' | '14b';
export type LlmMirror = 'huggingface' | 'hf-mirror' | 'auto';
export type LlmTaskKind = 'translate' | 'polish' | 'insight' | 'insight-map' | 'insight-reduce';
export type LlmQualityTier = 'fast' | 'balanced' | 'quality';

export interface LlmModelInfo {
  filename: string;
  sizeBytes: number;
  sha256?: string;
  /** Minimum recommended RAM in GB. */
  minRamGB: number;
}

export const LLM_MODELS: Record<LlmModelId, LlmModelInfo> = {
  '4b':  { filename: 'Qwen3-4B-Q4_K_M.gguf',  sizeBytes: 2_497_280_256, minRamGB: 8 },
  '8b':  { filename: 'Qwen3-8B-Q4_K_M.gguf',  sizeBytes: 5_027_783_488, minRamGB: 16 },
  '14b': { filename: 'Qwen3-14B-Q4_K_M.gguf', sizeBytes: 9_001_752_960, minRamGB: 32 },
};

/** All tier ids, in ascending-size order. Single source for API validators. */
export const LLM_MODEL_IDS = Object.keys(LLM_MODELS) as LlmModelId[];

export interface LlmModelCapability {
  id: LlmModelId;
  tasks: readonly LlmTaskKind[];
  qualityTier: LlmQualityTier;
  contextTokens: number;
  supportsJsonSchema: boolean;
  supportsThinking: boolean;
  recommendedMinMemoryGB: number;
}

const ALL_LLM_TASKS: readonly LlmTaskKind[] = [
  'translate',
  'polish',
  'insight',
  'insight-map',
  'insight-reduce',
];

export const LLM_MODEL_CAPABILITIES: Record<LlmModelId, LlmModelCapability> = {
  '4b': {
    id: '4b',
    tasks: ALL_LLM_TASKS,
    qualityTier: 'fast',
    contextTokens: 32_768,
    supportsJsonSchema: true,
    supportsThinking: true,
    recommendedMinMemoryGB: LLM_MODELS['4b'].minRamGB,
  },
  '8b': {
    id: '8b',
    tasks: ALL_LLM_TASKS,
    qualityTier: 'balanced',
    contextTokens: 32_768,
    supportsJsonSchema: true,
    supportsThinking: true,
    recommendedMinMemoryGB: LLM_MODELS['8b'].minRamGB,
  },
  '14b': {
    id: '14b',
    tasks: ALL_LLM_TASKS,
    qualityTier: 'quality',
    contextTokens: 32_768,
    supportsJsonSchema: true,
    supportsThinking: true,
    recommendedMinMemoryGB: LLM_MODELS['14b'].minRamGB,
  },
};

export function capabilityForModel(id: LlmModelId): LlmModelCapability {
  return LLM_MODEL_CAPABILITIES[id];
}

export function modelSupportsTask(id: LlmModelId, task: LlmTaskKind): boolean {
  return capabilityForModel(id).tasks.includes(task);
}

/**
 * User-facing name for a tier id ('8b' → 'Qwen3-8B'). Tier ids are internal
 * storage keys — anywhere a human reads the model, use this instead.
 */
export function llmDisplayName(id: LlmModelId): string {
  return `Qwen3-${id.toUpperCase()}`;
}

export function isLlmModelId(value: unknown): value is LlmModelId {
  return (
    typeof value === 'string' &&
    (LLM_MODEL_IDS as readonly string[]).includes(value)
  );
}

const MIRROR_PREFIX: Record<Exclude<LlmMirror, 'auto'>, (id: LlmModelId) => string> = {
  huggingface: (id) => `https://huggingface.co/Qwen/Qwen3-${idCase(id)}-GGUF/resolve/main`,
  'hf-mirror': (id) => `https://hf-mirror.com/Qwen/Qwen3-${idCase(id)}-GGUF/resolve/main`,
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

export const RECOMMENDED_LLM_MODEL: LlmModelId = '8b';

export interface HardwareHint {
  totalMemoryGB: number;
}

export function recommendLlmModel(hw: HardwareHint): LlmModelId {
  if (hw.totalMemoryGB >= 32) return '14b';
  if (hw.totalMemoryGB >= 16) return '8b';
  return '4b';
}
