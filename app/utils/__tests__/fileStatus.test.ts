/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';

import { getFileStatus } from '../fileStatus';
import { displayQueueModel } from '../modelDisplay';

const SHA = 'a'.repeat(64);

describe('getFileStatus', () => {
  it('surfaces a model-configuration translation failure as actionable file status', () => {
    const status = getFileStatus(
      { sha256: SHA, langs: ['original'] },
      [
        {
          kind: 'translate',
          videoSha: SHA,
          status: 'failed',
          progressPct: 0,
          targetLang: 'zh-CN',
          errorMsg: '/Users/me/llama-server failed to load model',
          errorCode: 'MODEL_NOT_CONFIGURED',
        },
      ],
    );

    expect(status.translateFailed).toEqual({
      targetLang: 'zh-CN',
      errorCode: 'MODEL_NOT_CONFIGURED',
    });
  });

  it('does not report stale Insight artifacts as done when the latest queue row is an error', () => {
    const status = getFileStatus(
      { sha256: SHA, langs: ['original'], hasInsights: true },
      [
        {
          kind: 'insight',
          videoSha: SHA,
          status: 'error',
          progressPct: 0,
          errorMsg: 'Local LLM model is not configured or unavailable.',
          errorCode: 'MODEL_NOT_CONFIGURED',
        },
      ],
    );

    expect(status.insight).toBe('failed');
    expect(status.insightErrorCode).toBe('MODEL_NOT_CONFIGURED');
  });

  it('prefers running Insight over previous errors', () => {
    const status = getFileStatus(
      { sha256: SHA, langs: ['original'], hasInsights: true },
      [
        {
          kind: 'insight',
          videoSha: SHA,
          status: 'error',
          progressPct: 0,
          errorCode: 'MODEL_NOT_CONFIGURED',
        },
        {
          kind: 'insight',
          videoSha: SHA,
          status: 'running',
          progressPct: 25,
        },
      ],
    );

    expect(status.insight).toBe('running');
  });
});

describe('displayQueueModel', () => {
  it.each([
    ['4b', 'Qwen3-4B'],
    ['8b', 'Qwen3-8B'],
    ['14b', 'Qwen3-14B'],
    ['llm', 'Qwen3'],
    ['sensevoice', 'SenseVoice'],
    ['whisper', 'Whisper'],
  ])('maps %s to %s', (model, label) => {
    expect(displayQueueModel(model)).toBe(label);
  });
});
