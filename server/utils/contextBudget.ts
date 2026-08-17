/* SPDX-License-Identifier: Apache-2.0 */

export interface InsightContextBudget {
  contextWindowTokens: number;
  finalOutputTokens: number;
  mapOutputTokens: number;
  safetyMarginTokens: number;
}

export interface InsightContextWindow {
  index: number;
  total: number;
  text: string;
  estimatedInputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface InsightContextPlan {
  mode: 'single' | 'map-reduce';
  transcriptTokens: number;
  contextWindowTokens: number;
  safetyMarginTokens: number;
  windows: InsightContextWindow[];
}

export const DEFAULT_INSIGHT_CONTEXT_BUDGET: InsightContextBudget = {
  contextWindowTokens: 8192,
  finalOutputTokens: 4096,
  mapOutputTokens: 1024,
  safetyMarginTokens: 512,
};

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

function normalizeBudget(overrides: Partial<InsightContextBudget> = {}): InsightContextBudget {
  const budget = { ...DEFAULT_INSIGHT_CONTEXT_BUDGET, ...overrides };
  if (budget.contextWindowTokens <= budget.finalOutputTokens + budget.safetyMarginTokens) {
    throw new Error('INSIGHT_CONTEXT_BUDGET_TOO_SMALL');
  }
  if (budget.contextWindowTokens <= budget.mapOutputTokens + budget.safetyMarginTokens) {
    throw new Error('INSIGHT_CONTEXT_BUDGET_TOO_SMALL');
  }
  return budget;
}

function splitPreservingNewlines(text: string): string[] {
  if (!text) return [''];
  const parts = text.split('\n');
  return parts.map((part, i) => (i < parts.length - 1 ? `${part}\n` : part)).filter(Boolean);
}

function splitOversizedUnit(unit: string, maxInputTokens: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const char of unit) {
    const next = current + char;
    if (current && estimateTextTokens(next) > maxInputTokens) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildWindows(text: string, maxInputTokens: number, maxOutputTokens: number): InsightContextWindow[] {
  const windows: Omit<InsightContextWindow, 'total'>[] = [];
  let current = '';

  for (const rawUnit of splitPreservingNewlines(text)) {
    const units = estimateTextTokens(rawUnit) > maxInputTokens
      ? splitOversizedUnit(rawUnit, maxInputTokens)
      : [rawUnit];

    for (const unit of units) {
      const next = current + unit;
      if (current && estimateTextTokens(next) > maxInputTokens) {
        windows.push({
          index: windows.length,
          text: current,
          estimatedInputTokens: estimateTextTokens(current),
          maxInputTokens,
          maxOutputTokens,
        });
        current = unit;
      } else {
        current = next;
      }
    }
  }

  if (current || windows.length === 0) {
    windows.push({
      index: windows.length,
      text: current,
      estimatedInputTokens: estimateTextTokens(current),
      maxInputTokens,
      maxOutputTokens,
    });
  }

  const total = windows.length;
  return windows.map((window) => ({ ...window, total }));
}

export function planInsightContext(
  transcript: string,
  overrides: Partial<InsightContextBudget> = {},
): InsightContextPlan {
  const budget = normalizeBudget(overrides);
  const transcriptTokens = estimateTextTokens(transcript);
  const singleInputBudget = budget.contextWindowTokens
    - budget.finalOutputTokens
    - budget.safetyMarginTokens;
  const mapInputBudget = budget.contextWindowTokens
    - budget.mapOutputTokens
    - budget.safetyMarginTokens;

  if (transcriptTokens <= singleInputBudget) {
    return {
      mode: 'single',
      transcriptTokens,
      contextWindowTokens: budget.contextWindowTokens,
      safetyMarginTokens: budget.safetyMarginTokens,
      windows: buildWindows(transcript, singleInputBudget, budget.finalOutputTokens),
    };
  }

  return {
    mode: 'map-reduce',
    transcriptTokens,
    contextWindowTokens: budget.contextWindowTokens,
    safetyMarginTokens: budget.safetyMarginTokens,
    windows: buildWindows(transcript, mapInputBudget, budget.mapOutputTokens),
  };
}
