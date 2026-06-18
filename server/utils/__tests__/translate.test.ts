/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMBackend } from '../llmClient';
import type { Cue } from '../vtt';

const chatMock = vi.hoisted(() => vi.fn<LLMBackend['chat']>());

vi.mock('../llmClient', () => ({
  llmBackend: () => ({
    chat: chatMock,
    // eslint-disable-next-line require-yield
    async *chatStream() {
      return;
    },
  }),
}));

vi.mock('../log', () => ({
  logEvent: vi.fn(),
}));

/* eslint-disable import/first -- mocks must be registered before imports */
import { logEvent } from '../log';
import { translateAll } from '../translate';
/* eslint-enable import/first */

function cue(i: number): Cue {
  return {
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: `source ${i}`,
  };
}

function jsonItems(prefix: string, n: number): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => `${prefix} ${i}`));
}

beforeEach(() => {
  chatMock.mockReset();
  vi.mocked(logEvent).mockClear();
});

describe('translateAll', () => {
  it('uses 25-cue super batches to reduce local LLM format drift', async () => {
    chatMock.mockImplementation(async (opts) => {
      const match = opts.messages.at(-1)?.content.match(/INPUT \((\d+) subtitle/);
      const n = Number(match?.[1] ?? 0);
      return jsonItems('translated', n);
    });

    const out = await translateAll(Array.from({ length: 26 }, (_, i) => cue(i)), 'zh-CN');

    expect(out).toHaveLength(26);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls.map(([opts]) => opts.messages.at(-1)?.content)).toEqual([
      expect.stringContaining('INPUT (25 subtitles to translate):'),
      expect.stringContaining('INPUT (1 subtitle to translate):'),
    ]);
  });

  it('falls back from a mismatched super batch to smaller sub-batches with diagnostic logs', async () => {
    chatMock
      .mockResolvedValueOnce(jsonItems('too-few', 24))
      .mockResolvedValueOnce(jsonItems('sub-a', 15))
      .mockResolvedValueOnce(jsonItems('sub-b', 10));

    const retries: unknown[] = [];
    const out = await translateAll(Array.from({ length: 25 }, (_, i) => cue(i)), 'en-US', {
      onBatchRetry: (info) => retries.push(info),
    });

    expect(out).toHaveLength(25);
    expect(out[0]?.text).toBe('sub-a 0');
    expect(out[24]?.text).toBe('sub-b 9');
    expect(retries).toEqual([{ batchIdx: 0, attempt: 1, reason: 'count-mismatch' }]);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'translate_count_mismatch',
      attempt: 1,
      targetLang: 'en-US',
      expectedCount: 25,
      actualCount: 24,
      parseOk: true,
      rawPreview: expect.any(String),
    }));
  });

  it('falls back to per-cue translation and then source text when needed', async () => {
    chatMock
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce(jsonItems('still-wrong', 14))
      .mockResolvedValueOnce(jsonItems('single', 1))
      .mockResolvedValueOnce('not json');

    const out = await translateAll([cue(0), cue(1)], 'ja-JP');

    expect(out).toEqual([
      expect.objectContaining({ text: 'single 0' }),
      expect.objectContaining({ text: 'source 1' }),
    ]);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'translate_count_mismatch',
      attempt: 1,
      parseOk: false,
      actualCount: null,
    }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'translate_count_mismatch',
      attempt: 2,
      expectedCount: 2,
      actualCount: 14,
    }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'translate_cue_fallback',
      targetLang: 'ja-JP',
      cueStartMs: 1000,
    }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'translate_fallback_summary',
      targetLang: 'ja-JP',
      fallbackCount: 1,
      totalCues: 2,
    }));
  });
});
