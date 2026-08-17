/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';

import {
  LLM_MODEL_CAPABILITIES,
  LLM_MODEL_IDS,
  capabilityForModel,
  modelSupportsTask,
} from '#shared/llmModels';

describe('LLM model capabilities', () => {
  it('defines capability metadata for every model id', () => {
    expect(Object.keys(LLM_MODEL_CAPABILITIES).sort()).toEqual([...LLM_MODEL_IDS].sort());

    for (const id of LLM_MODEL_IDS) {
      const capability = capabilityForModel(id);
      expect(capability.id).toBe(id);
      expect(capability.tasks.length).toBeGreaterThan(0);
      expect(capability.contextTokens).toBeGreaterThan(0);
      expect(capability.recommendedMinMemoryGB).toBeGreaterThan(0);
    }
  });

  it('keeps metadata runtime-neutral and free of paths or download URLs', () => {
    const serialized = JSON.stringify(LLM_MODEL_CAPABILITIES);

    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/Documents\/Code/);
    expect(serialized).not.toMatch(/node_modules/);
    expect(serialized).not.toMatch(/\.gguf/);
  });

  it('marks the current balanced model as supporting translate, polish, and Insight', () => {
    expect(modelSupportsTask('8b', 'translate')).toBe(true);
    expect(modelSupportsTask('8b', 'polish')).toBe(true);
    expect(modelSupportsTask('8b', 'insight')).toBe(true);
    expect(capabilityForModel('8b').qualityTier).toBe('balanced');
  });

  it('marks 4b as a valid fast-task model', () => {
    expect(capabilityForModel('4b').qualityTier).toBe('fast');
    expect(modelSupportsTask('4b', 'translate')).toBe(true);
    expect(modelSupportsTask('4b', 'polish')).toBe(true);
    expect(modelSupportsTask('4b', 'insight-map')).toBe(true);
  });

  it('marks 14b as valid for quality-heavy Insight reduce tasks', () => {
    expect(capabilityForModel('14b').qualityTier).toBe('quality');
    expect(modelSupportsTask('14b', 'insight')).toBe(true);
    expect(modelSupportsTask('14b', 'insight-reduce')).toBe(true);
  });
});
