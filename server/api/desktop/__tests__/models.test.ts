/* SPDX-License-Identifier: Apache-2.0 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSyncMock,
  findLegacyMock,
  getDbMock,
  getLlmServerMock,
  detectSubcastSidecarsMock,
  getWhisperServerMock,
  loadSettingsMock,
  scanLlmModelsMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
  findLegacyMock: vi.fn(async () => []),
  getDbMock: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ n: 0 })),
      all: vi.fn(() => []),
    })),
  })),
  getLlmServerMock: vi.fn(() => ({
    snapshot: vi.fn(() => ({
      state: 'running',
      modelId: '8b',
      runtimeProfileId: 'standard',
      idleShutdownMs: 120_000,
      idleDeadlineAt: 1_800_000_000_000,
      activeRequests: 1,
    })),
  })),
  detectSubcastSidecarsMock: vi.fn(async () => ({
    llamaServer: false,
    whisperServer: false,
  })),
  getWhisperServerMock: vi.fn(() => ({
    snapshot: vi.fn(() => ({
      state: 'idle',
      idleShutdownMs: 120_000,
      idleDeadlineAt: null,
    })),
  })),
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

vi.mock('../../../utils/db', () => ({
  getDb: getDbMock,
}));

vi.mock('../../../utils/whisperInstalled', () => ({
  listInstalledWhisperModels: vi.fn(async () => [{ name: 'base', sizeBytes: 1000 }]),
}));

vi.mock('../../../utils/sensevoice', () => ({
  isSenseVoiceReady: vi.fn(() => true),
  senseVoiceModelDir: vi.fn(() => '/subcast/models/sensevoice'),
}));

vi.mock('../../../utils/llmServer', () => ({
  getLlmServer: getLlmServerMock,
}));

vi.mock('../../../utils/sidecarProcessStatus', () => ({
  detectSubcastSidecars: detectSubcastSidecarsMock,
}));

vi.mock('../../../utils/whisperServer', () => ({
  getWhisperServer: getWhisperServerMock,
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

    expect(res.llm.runtime).toEqual({
      state: 'running',
      modelId: '8b',
      runtimeProfileId: 'standard',
      idleShutdownMs: 120_000,
      idleDeadlineAt: 1_800_000_000_000,
      activeRequests: 1,
    });
    expect(res.transcribeRuntime).toEqual({
      state: 'idle',
      activeTasks: 0,
      engines: [],
      whisper: {
        state: 'idle',
        idleShutdownMs: 120_000,
        idleDeadlineAt: null,
      },
    });
    expect(getLlmServerMock).toHaveBeenCalledTimes(1);
    expect(res.llm.taskPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: 'translate', modelId: '8b', dryRun: true }),
        expect.objectContaining({ task: 'polish', modelId: '8b', dryRun: true }),
        expect.objectContaining({ task: 'insight', modelId: '8b', dryRun: true }),
      ]),
    );
    expect(res.llm.taskPolicies.every((policy) => policy.policyId === 'llm-task-policy-v1')).toBe(true);
    expect(existsSyncMock).toHaveBeenCalledWith('/subcast/models/llm/8b.gguf');
    expect(JSON.stringify(res.llm.runtime)).not.toMatch(/\/subcast|\.gguf|argv|stderr/);
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

  it('defaults missing transcribeEngine to auto', async () => {
    loadSettingsMock.mockReturnValueOnce({
      whisperModel: 'base',
      llmModel: '8b',
    });

    const res = await modelsHandler({} as never);

    expect(res.transcribeEngine).toBe('auto');
  });

  it('falls back to running task rows when the runtime singleton is stale', async () => {
    getLlmServerMock.mockReturnValueOnce({
      snapshot: vi.fn(() => ({
        state: 'idle',
        modelId: null,
        runtimeProfileId: null,
        idleShutdownMs: 120_000,
        idleDeadlineAt: null,
        activeRequests: 0,
      })),
    });
    getDbMock.mockReturnValueOnce({
      prepare: vi
        .fn()
        .mockReturnValueOnce({ get: vi.fn(() => ({ n: 1 })) })
        .mockReturnValueOnce({ all: vi.fn(() => []) }),
    });

    const res = await modelsHandler({} as never);

    expect(res.llm.runtime).toMatchObject({
      state: 'running',
      modelId: '8b',
      idleDeadlineAt: null,
      activeRequests: 1,
    });
  });

  it('surfaces running transcription separately from AI runtime', async () => {
    const db = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ get: vi.fn(() => ({ n: 0 })) })
        .mockReturnValueOnce({ all: vi.fn(() => [{ engine: 'whisper', n: 2 }]) }),
    };
    getDbMock.mockReturnValueOnce(db).mockReturnValueOnce(db);
    getWhisperServerMock.mockReturnValueOnce({
      snapshot: vi.fn(() => ({
        state: 'running',
        idleShutdownMs: 120_000,
        idleDeadlineAt: 1_800_000_100_000,
      })),
    });

    const res = await modelsHandler({} as never);

    expect(res.transcribeRuntime).toEqual({
      state: 'running',
      activeTasks: 2,
      engines: ['whisper'],
      whisper: {
        state: 'running',
        idleShutdownMs: 120_000,
        idleDeadlineAt: 1_800_000_100_000,
      },
    });
  });

  it('falls back to Subcast sidecar processes when runtime owners are stale', async () => {
    getLlmServerMock.mockReturnValueOnce({
      snapshot: vi.fn(() => ({
        state: 'idle',
        modelId: null,
        runtimeProfileId: null,
        idleShutdownMs: 120_000,
        idleDeadlineAt: null,
        activeRequests: 0,
      })),
    });
    detectSubcastSidecarsMock.mockResolvedValueOnce({
      llamaServer: true,
      whisperServer: true,
    });

    const res = await modelsHandler({} as never);

    expect(res.llm.runtime).toMatchObject({
      state: 'running',
      modelId: '8b',
      idleDeadlineAt: null,
      activeRequests: 0,
    });
    expect(res.transcribeRuntime).toEqual({
      state: 'running',
      activeTasks: 0,
      engines: [],
      whisper: {
        state: 'running',
        idleShutdownMs: 120_000,
        idleDeadlineAt: null,
      },
    });
    expect(JSON.stringify(res.llm.runtime)).not.toMatch(/\/subcast|\.gguf|argv|stderr|pid|port/);
    expect(JSON.stringify(res.transcribeRuntime)).not.toMatch(/\/subcast|\.bin|argv|stderr|pid|port/);
  });
});
