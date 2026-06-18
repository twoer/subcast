/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared types for the settings page and its tab components.
 * Kept outside app/pages so Nuxt does not try to register it as a route.
 */

import type { WhisperModelName } from '#shared/whisperModels';
import type { LlmModelId } from '#shared/llmModels';

export type ChunkingStrategy = 'vad' | 'fixed-time';

export interface Settings {
  whisperModel: WhisperModelName;
  llmModel: LlmModelId | undefined;
  cacheLimitGB: number;
  silenceThresholdMs: number;
  debugMode: boolean;
  chunkingStrategy: ChunkingStrategy;
}

export interface Hardware {
  totalMemoryGB: number;
  cpuCount: number;
  cpuModel: string;
  platform: string;
  arch: string;
  gpu: string;
  tier: 'entry' | 'standard' | 'recommended' | 'high';
  recommended: { whisperModel: string; llmModel: LlmModelId };
  lanIp?: string;
}
