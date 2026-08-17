/* SPDX-License-Identifier: Apache-2.0 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSyncMock, findLegacyMock, loadSettingsMock, scanLlmModelsMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
  findLegacyMock: vi.fn(async () => []),
  loadSettingsMock: vi.fn(() => ({
    transcribeEngine: 'sensevoice',
    whisperModel: 'base',
    llmModel: '8b',
  })),
  scanLlmModelsMock: vi.fn(async () => [
    {
      name: '8b',
      path: '/subcast/models/llm/8b.gguf',
      source: 'subcast',
      sizeBytes: 5_027_783_488,
    },
  ]),
}));

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('../../../utils/settings', () => ({
  loadSettings: loadSettingsMock,
}));

vi.mock('../../../utils/whisperInstalled', () => ({
  listInstalledWhisperModels: vi.fn(async () => [{ name: 'base', sizeBytes: 1000 }]),
}));

vi.mock('../../../utils/sensevoice', () => ({
  isSenseVoiceReady: vi.fn(() => true),
  senseVoiceModelDir: vi.fn(() => '/subcast/models/sensevoice'),
}));

vi.mock('../../../../desktop/modelManager/llmScan', () => ({
  scanLlmModels: scanLlmModelsMock,
  findLegacyQwen25Models: findLegacyMock,
}));

vi.mock('../../../../desktop/modelManager/llmInstall', () => ({
  llmModelPath: (id: string) => `/subcast/models/llm/${id}.gguf`,
  llmModelsDir: () => '/subcast/models/llm',
}));

/* eslint-disable import/first -- mocks must be registered before imports */
import modelsHandler from '../models.get';
/* eslint-enable import/first */

describe('GET /api/desktop/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBCAST_DESKTOP = 'true';
  });

  afterEach(() => {
    delete process.env.SUBCAST_DESKTOP;
  });

  it('surfaces dry-run LLM task policy decisions for settings', async () => {
    const res = await modelsHandler({} as never);

    expect(res.llm.taskPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: 'translate', modelId: '8b', dryRun: true }),
        expect.objectContaining({ task: 'polish', modelId: '8b', dryRun: true }),
        expect.objectContaining({ task: 'insight', modelId: '8b', dryRun: true }),
      ]),
    );
    expect(res.llm.taskPolicies.every((policy) => policy.policyId === 'llm-task-policy-v1')).toBe(true);
    expect(existsSyncMock).toHaveBeenCalledWith('/subcast/models/llm/8b.gguf');
  });

  it('keeps task policies empty when no LLM model is configured', async () => {
    loadSettingsMock.mockReturnValueOnce({
      transcribeEngine: 'sensevoice',
      whisperModel: 'base',
      llmModel: undefined,
    });

    const res = await modelsHandler({} as never);

    expect(res.llm.taskPolicies).toEqual([]);
  });
});
