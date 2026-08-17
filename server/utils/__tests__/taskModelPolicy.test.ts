/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';

import {
  selectTaskModel,
  taskModelPolicyDecisions,
} from '../taskModelPolicy';

describe('taskModelPolicy', () => {
  it('selects the configured compatible model for translate', () => {
    expect(selectTaskModel({
      task: 'translate',
      configuredModel: '8b',
      installedModels: ['4b', '8b', '14b'],
    })).toMatchObject({
      modelId: '8b',
      task: 'translate',
      fallback: false,
      dryRun: true,
    });
  });

  it('selects the configured compatible model for polish', () => {
    expect(selectTaskModel({
      task: 'polish',
      configuredModel: '8b',
      installedModels: ['4b', '8b'],
    }).modelId).toBe('8b');
  });

  it('selects the configured compatible model for short Insight', () => {
    expect(selectTaskModel({
      task: 'insight',
      configuredModel: '8b',
      installedModels: ['8b', '14b'],
    }).modelId).toBe('8b');
  });

  it('lets long Insight map prefer a fast or balanced installed model', () => {
    const decision = selectTaskModel({
      task: 'insight-map',
      configuredModel: '14b',
      installedModels: ['4b', '14b'],
    });

    expect(decision).toMatchObject({
      modelId: '4b',
      task: 'insight-map',
      fallback: true,
    });
  });

  it('lets long Insight reduce prefer quality only when installed and allowed', () => {
    expect(selectTaskModel({
      task: 'insight-reduce',
      configuredModel: '8b',
      installedModels: ['8b', '14b'],
      allowQualityRouting: true,
    }).modelId).toBe('14b');

    expect(selectTaskModel({
      task: 'insight-reduce',
      configuredModel: '8b',
      installedModels: ['8b', '14b'],
      allowQualityRouting: false,
    }).modelId).toBe('8b');
  });

  it('falls back to the configured model when installed-model inventory is unavailable', () => {
    const decision = selectTaskModel({
      task: 'insight-reduce',
      configuredModel: '8b',
      allowQualityRouting: true,
    });

    expect(decision).toMatchObject({
      modelId: '8b',
      fallback: false,
      reason: expect.stringContaining('inventory-unavailable'),
    });
  });

  it('returns a typed error when no compatible model exists', () => {
    expect(() =>
      selectTaskModel({
        task: 'translate',
        installedModels: [],
      }),
    ).toThrow(/NO_COMPATIBLE_LLM_MODEL/);
  });

  it('builds dry-run decisions without changing current single-model behavior', () => {
    const decisions = taskModelPolicyDecisions({
      configuredModel: '8b',
      installedModels: ['8b'],
      dryRun: true,
    });

    expect(decisions.every((decision) => decision.dryRun)).toBe(true);
    expect(decisions.every((decision) => decision.modelId === '8b')).toBe(true);
    expect(decisions.map((decision) => decision.policyId)).toEqual([
      'llm-task-policy-v1',
      'llm-task-policy-v1',
      'llm-task-policy-v1',
      'llm-task-policy-v1',
      'llm-task-policy-v1',
    ]);
  });
});
