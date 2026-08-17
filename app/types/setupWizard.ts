/* SPDX-License-Identifier: Apache-2.0 */
import type { LlmModelId, LlmTaskKind } from '#shared/llmModels';
import type { WhisperModelName as CanonicalWhisperModelName } from '#shared/whisperModels';

export type WhisperModelName = Extract<
  CanonicalWhisperModelName,
  'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo'
>;
export type WhisperMirror = 'huggingface' | 'hf-mirror' | 'auto';
export type ScanAction = 'symlink' | 'copy' | 'ignore';

export interface ScannedModel {
  name: WhisperModelName;
  path: string;
  source: string;
  installed: boolean;
}

export interface SetupStatus {
  hasWhisperModel: boolean;
  whisperModels: ScannedModel[];
  recommendedWhisperModel: WhisperModelName;
}

export interface LlmInstalledHit {
  name: LlmModelId;
  path: string;
  sizeBytes: number;
}

export interface LlmScannedHit {
  name: LlmModelId;
  path: string;
  source: string;
  sizeBytes: number;
}

export interface LlmTaskPolicyDecision {
  modelId: LlmModelId;
  policyId: string;
  task: LlmTaskKind;
  reason: string;
  fallback: boolean;
  dryRun: boolean;
}

export interface LlmStatusResp {
  active: LlmModelId | undefined;
  recommended: LlmModelId;
  totalMemoryGB: number;
  runtimeProfile: {
    id: string;
    requestedBackend: 'metal' | 'cuda' | 'cpu' | 'unknown';
    verifiedBackend: 'metal' | 'cuda' | 'cpu' | 'unknown';
    verified: boolean;
    gpuBackend: 'metal' | 'cuda' | 'cpu' | 'unknown';
    parallelSlots: number;
    perSlotContext: number;
    warnings: string[];
  };
  taskPolicies: LlmTaskPolicyDecision[];
  migrationHint: LlmModelId | undefined;
  installed: LlmInstalledHit[];
  scanned: LlmScannedHit[];
}
