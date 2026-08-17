/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';

import type { LlmModelId, LlmTaskKind } from '#shared/llmModels';

export interface ModelBenchmarkResult {
  fixtureId?: string;
  fixtureHash?: string;
  modelId: LlmModelId;
  task: LlmTaskKind;
  ok: boolean;
  dryRun?: boolean;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
  jsonValid?: boolean;
  score: number;
  errorClass?: string;
}

export interface ModelBenchmarkReport {
  schemaVersion: 'llm-benchmark-report-v1';
  generatedAt: string;
  fixtures?: Array<{
    id: string;
    task: LlmTaskKind;
    locale?: string;
    hash: string;
  }>;
  results: ModelBenchmarkResult[];
}

export interface ShapeModelBenchmarkResultInput {
  fixtureId?: string;
  fixtureHash?: string;
  modelId: LlmModelId;
  task: LlmTaskKind;
  ok: boolean;
  dryRun?: boolean;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  jsonValid?: boolean;
  error?: unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function benchmarkFixtureHash(fixture: unknown): string {
  return sha256(JSON.stringify(fixture));
}

export function benchmarkTokensPerSecond(input: {
  completionTokens?: number;
  durationMs: number;
}): number | undefined {
  if (
    input.completionTokens === undefined ||
    input.completionTokens <= 0 ||
    input.durationMs <= 0
  ) {
    return undefined;
  }
  return Number((input.completionTokens / (input.durationMs / 1000)).toFixed(2));
}

export function errorClass(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

export function scoreBenchmarkResult(input: {
  ok: boolean;
  durationMs: number;
  jsonValid?: boolean;
  tokensPerSecond?: number;
  errorClass?: string;
}): number {
  if (!input.ok || input.errorClass) return 0;
  let score = 60;
  if (input.jsonValid === true) score += 20;
  if (input.jsonValid === false) score -= 20;
  score += Math.min(20, Math.round(input.tokensPerSecond ?? 0));
  score -= Math.min(20, Math.floor(input.durationMs / 10_000));
  return Math.max(0, Math.min(100, score));
}

export function shapeModelBenchmarkResult(
  input: ShapeModelBenchmarkResultInput,
): ModelBenchmarkResult {
  const tokensPerSecond = benchmarkTokensPerSecond({
    completionTokens: input.completionTokens,
    durationMs: input.durationMs,
  });
  const errClass = errorClass(input.error);
  const score = scoreBenchmarkResult({
    ok: input.ok,
    durationMs: input.durationMs,
    jsonValid: input.jsonValid,
    tokensPerSecond,
    errorClass: errClass,
  });

  return {
    ...(input.fixtureId !== undefined ? { fixtureId: input.fixtureId } : {}),
    ...(input.fixtureHash !== undefined ? { fixtureHash: input.fixtureHash } : {}),
    modelId: input.modelId,
    task: input.task,
    ok: input.ok,
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    durationMs: input.durationMs,
    ...(input.promptTokens !== undefined ? { promptTokens: input.promptTokens } : {}),
    ...(input.completionTokens !== undefined ? { completionTokens: input.completionTokens } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    ...(input.jsonValid !== undefined ? { jsonValid: input.jsonValid } : {}),
    score,
    ...(errClass !== undefined ? { errorClass: errClass } : {}),
  };
}

export function buildModelBenchmarkReport(
  results: ModelBenchmarkResult[],
  generatedAt = new Date().toISOString(),
  fixtures?: ModelBenchmarkReport['fixtures'],
): ModelBenchmarkReport {
  return {
    schemaVersion: 'llm-benchmark-report-v1',
    generatedAt,
    ...(fixtures !== undefined ? { fixtures: fixtures.map((fixture) => ({ ...fixture })) } : {}),
    results: results.map((result) => ({ ...result })),
  };
}
