/* SPDX-License-Identifier: Apache-2.0 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelTranscribe, cancelLlm, stopLlm, stopWhisper } = vi.hoisted(() => ({
  cancelTranscribe: vi.fn(async () => undefined),
  cancelLlm: vi.fn(async () => undefined),
  stopLlm: vi.fn(async () => undefined),
  stopWhisper: vi.fn(async () => undefined),
}));

vi.mock('../../../utils/queue', () => ({
  transcribeQueue: { cancelActive: cancelTranscribe },
  llmQueue: { cancelActive: cancelLlm },
}));

vi.mock('../../../utils/llmServer', () => ({
  getLlmServer: () => ({ stop: stopLlm }),
}));

vi.mock('../../../utils/whisperServer', () => ({
  getWhisperServer: () => ({ stop: stopWhisper }),
}));

/* eslint-disable import/first -- mocks must be registered before imports */
import shutdownHandler from '../shutdown.post';
/* eslint-enable import/first */

describe('POST /api/desktop/shutdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUBCAST_DESKTOP = 'true';
  });

  afterEach(() => {
    delete process.env.SUBCAST_DESKTOP;
  });

  it('cancels active work and stops both resident model servers', async () => {
    await shutdownHandler({} as never);

    expect(cancelTranscribe).toHaveBeenCalledOnce();
    expect(cancelLlm).toHaveBeenCalledOnce();
    expect(stopLlm).toHaveBeenCalledOnce();
    expect(stopWhisper).toHaveBeenCalledOnce();
  });

  it('still stops Whisper when the LLM server fails to stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stopLlm.mockRejectedValueOnce(new Error('stop failed'));

    await expect(shutdownHandler({} as never)).resolves.toEqual({ ok: true });

    expect(stopWhisper).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[shutdown] llm server stop failed:',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
