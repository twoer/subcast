/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { PROMPT_VERSIONS, SCHEMA_VERSIONS } from './invocationSpec';
import { TASK_MODEL_POLICY_ID } from './taskModelPolicy';
import type { LlmTaskKind } from '#shared/llmModels';

export interface ArtifactFingerprintInput {
  kind: 'insight' | 'translate' | 'polish';
  videoSha: string;
  sourceHash: string;
  language?: string;
  modelId: string;
  taskRole?: LlmTaskKind;
  policyId?: string;
  promptVersion: string;
  schemaVersion: string;
  generationHash: string;
  hintsHash?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export function hashArtifactSource(sourceText: string): string {
  return sha256(sourceText);
}

export function hashArtifactGenerationOptions(value: unknown): string {
  return sha256(stableJson(value));
}

export function artifactFingerprint(input: ArtifactFingerprintInput): string {
  return sha256(stableJson(input));
}

export function insightSourceRevision(transcript: string): string {
  return `transcript:${hashArtifactSource(transcript)}`;
}

export function buildInsightArtifactFingerprint(input: {
  videoSha: string;
  transcript: string;
  uiLanguage: 'zh-CN' | 'en';
  modelId: string;
  taskRole?: LlmTaskKind;
  policyId?: string;
}): string {
  return artifactFingerprint({
    kind: 'insight',
    videoSha: input.videoSha,
    sourceHash: hashArtifactSource(input.transcript),
    language: input.uiLanguage,
    modelId: input.modelId,
    taskRole: input.taskRole ?? 'insight',
    policyId: input.policyId ?? TASK_MODEL_POLICY_ID,
    promptVersion: PROMPT_VERSIONS.insight,
    schemaVersion: SCHEMA_VERSIONS.insight,
    generationHash: hashArtifactGenerationOptions({ temperature: 0.3, maxTokens: 4096 }),
  });
}
