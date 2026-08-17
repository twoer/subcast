/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';

import { isLlmModelId, type LlmModelId } from '#shared/llmModels';

export type InvocationKind = 'translate' | 'polish' | 'insight';
export type InvocationBackend = 'llama-server';

export interface InvocationSpec {
  kind: InvocationKind;
  modelId: LlmModelId;
  backend: InvocationBackend;
  promptVersion: string;
  schemaVersion: string;
  sourceRevision: string;
  language?: string;
  hintsHash?: string;
  generation: {
    temperature: number;
    maxTokens?: number;
    responseSchemaName?: string;
  };
}

interface BaseSpecInput {
  modelId: unknown;
  sourceRevision: string;
}

interface TranslateSpecInput extends BaseSpecInput {
  language: string;
}

interface PolishSpecInput extends BaseSpecInput {
  hints?: string;
}

interface InsightSpecInput extends BaseSpecInput {
  uiLanguage: 'zh-CN' | 'en';
}

const BACKEND: InvocationBackend = 'llama-server';
const JSON_STRING_ARRAY_SCHEMA = 'json-string-array';

export const PROMPT_VERSIONS = {
  translate: 'translate-v1',
  polish: 'polish-v1',
  insight: 'insight-v1',
} as const;

export const SCHEMA_VERSIONS = {
  translate: 'json-string-array-v1',
  polish: 'json-string-array-v1',
  insight: 'insight-markdown-v1',
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireLlmModelId(value: unknown): LlmModelId {
  if (!isLlmModelId(value)) {
    throw new Error(`UNKNOWN_LLM_MODEL: ${String(value)}`);
  }
  return value;
}

export function hashInvocationHint(hints: string): string {
  return sha256(hints.trim());
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export function invocationFingerprint(spec: InvocationSpec): string {
  return sha256(stableJson(spec));
}

export function buildTranslateInvocationSpec(input: TranslateSpecInput): InvocationSpec {
  return {
    kind: 'translate',
    modelId: requireLlmModelId(input.modelId),
    backend: BACKEND,
    promptVersion: PROMPT_VERSIONS.translate,
    schemaVersion: SCHEMA_VERSIONS.translate,
    sourceRevision: input.sourceRevision,
    language: input.language,
    generation: {
      temperature: 0,
      responseSchemaName: JSON_STRING_ARRAY_SCHEMA,
    },
  };
}

export function buildPolishInvocationSpec(input: PolishSpecInput): InvocationSpec {
  const hints = input.hints?.trim();
  return {
    kind: 'polish',
    modelId: requireLlmModelId(input.modelId),
    backend: BACKEND,
    promptVersion: PROMPT_VERSIONS.polish,
    schemaVersion: SCHEMA_VERSIONS.polish,
    sourceRevision: input.sourceRevision,
    ...(hints ? { hintsHash: hashInvocationHint(hints) } : {}),
    generation: {
      temperature: 0,
      responseSchemaName: JSON_STRING_ARRAY_SCHEMA,
    },
  };
}

export function buildInsightInvocationSpec(input: InsightSpecInput): InvocationSpec {
  return {
    kind: 'insight',
    modelId: requireLlmModelId(input.modelId),
    backend: BACKEND,
    promptVersion: PROMPT_VERSIONS.insight,
    schemaVersion: SCHEMA_VERSIONS.insight,
    sourceRevision: input.sourceRevision,
    language: input.uiLanguage,
    generation: {
      temperature: 0.3,
      maxTokens: 4096,
    },
  };
}

