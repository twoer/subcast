/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMBackend, LLMChatResult } from '../llmClient';
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
import { buildPolishMessages, polishAll } from '../polish';
/* eslint-enable import/first */

function cue(i: number, text?: string): Cue {
  return {
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    text: text ?? `原文 ${i}`,
  };
}

beforeEach(() => {
  chatMock.mockReset();
  vi.mocked(logEvent).mockClear();
});

function chatResult(content: string): LLMChatResult {
  return {
    content,
    finishReason: 'stop',
    usage: { promptTokens: 11, completionTokens: 7 },
    timing: { prefillMs: 2, decodeMs: 3, totalMs: 5 },
    retries: 0,
    coldStart: false,
  };
}

describe('buildPolishMessages', () => {
  it('injects user hints as a term list when present', () => {
    const msgs = buildPolishMessages([cue(0)], '庐州府学、布尔运算', []);
    const user = msgs.at(-1)!.content;
    expect(user).toContain('庐州府学');
    expect(user).toContain('布尔运算');
    expect(user).toContain('专有名词提示');
  });

  it('omits the hints block entirely when hints are blank', () => {
    const msgs = buildPolishMessages([cue(0)], '   ', []);
    expect(msgs.at(-1)!.content).not.toContain('专有名词提示');
  });

  it('carries rolling context pairs for term consistency', () => {
    const msgs = buildPolishMessages(
      [cue(0)],
      '',
      [{ src: '原文 9', polished: '润色 9' }],
    );
    expect(msgs.at(-1)!.content).toContain('CONTEXT');
    expect(msgs.at(-1)!.content).toContain('润色 9');
  });

  it('demands a same-length JSON array', () => {
    const batch = [cue(0), cue(1)];
    const msgs = buildPolishMessages(batch, '', []);
    expect(msgs.at(-1)!.content).toContain(`JSON array of exactly ${batch.length} strings`);
    expect(msgs[0]!.role).toBe('system');
  });
});

describe('polishAll', () => {
  /** Mock that complies with the count contract and numbers items globally. */
  function mockCompliantChat(): void {
    let emitted = 0;
    chatMock.mockImplementation(async (opts) => {
      const m = opts.messages.at(-1)?.content.match(/(\d+) 条字幕待修正/);
      const n = Number(m?.[1]);
      return chatResult(JSON.stringify(Array.from({ length: n }, () => `润色 ${emitted++}`)));
    });
  }

  it('keeps cue count and timestamps in strict 1:1 with the input', async () => {
    const input = Array.from({ length: 26 }, (_, i) => cue(i));
    mockCompliantChat();

    const out = await polishAll(input);

    expect(out).toHaveLength(26);
    for (let i = 0; i < 26; i++) {
      expect(out[i]!.startMs).toBe(input[i]!.startMs);
      expect(out[i]!.endMs).toBe(input[i]!.endMs);
      expect(out[i]!.text).toBe(`润色 ${i}`);
    }
    // Grammar constraint rides along on every call with the batch length.
    expect(chatMock.mock.calls.map(([opts]) => opts.responseSchema)).toEqual([
      { type: 'array', items: { type: 'string' }, minItems: 25, maxItems: 25 },
      { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 },
    ]);
  });

  it('falls back to the original text when the model never complies', async () => {
    const input = [cue(0, '球叉运算'), cue(1, '音化同步')];
    chatMock.mockResolvedValue(chatResult('抱歉，我无法处理。')); // no JSON array at all

    const out = await polishAll(input, { hints: '布尔运算' });

    expect(out).toHaveLength(2);
    // Degradation ladder: batch attempt → retry batch → give up and keep
    // the original text (no per-cue third attempt — polish without
    // context isn't worth a call).
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.text)).toEqual(['球叉运算', '音化同步']);
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'polish_fallback_summary', fallbackCount: 1 }),
    );
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(expect.objectContaining({
      event: 'polish_batch_mismatch',
      finishReason: 'stop',
      retries: 0,
      coldStart: false,
      promptTokens: 11,
      completionTokens: 7,
      prefillMs: 2,
      decodeMs: 3,
      totalMs: 5,
    }));
    for (const [entry] of vi.mocked(logEvent).mock.calls) {
      expect(entry).not.toHaveProperty('rawPreview');
      expect(JSON.stringify(entry)).not.toContain('球叉运算');
      expect(JSON.stringify(entry)).not.toContain('音化同步');
      expect(JSON.stringify(entry)).not.toContain('布尔运算');
    }
  });

  it('recovers via the smaller retry batch on a count mismatch', async () => {
    const input = Array.from({ length: 12 }, (_, i) => cue(i));
    let call = 0;
    chatMock.mockImplementation(async (opts) => {
      call++;
      const m = opts.messages.at(-1)?.content.match(/(\d+) 条字幕待修正/);
      const n = Number(m?.[1]);
      // First (12-cue) attempt drops one item; the 10-cue retries comply.
      if (n === 12) return chatResult(JSON.stringify(Array.from({ length: 11 }, (_, i) => `x ${i}`)));
      return chatResult(JSON.stringify(Array.from({ length: n }, () => `ok ${call}`)));
    });

    const out = await polishAll(input);

    expect(call).toBe(3); // 1 failed attempt + 2 retry batches (10 + 2)
    expect(out).toHaveLength(12);
    expect(out.slice(0, 10).map((c) => c.text)).toEqual(Array(10).fill('ok 2'));
    expect(out.slice(10).map((c) => c.text)).toEqual(['ok 3', 'ok 3']);
  });

  it('keeps the original text for empty-string model output', async () => {
    chatMock.mockResolvedValue(chatResult(JSON.stringify(['润色 0', ''])));

    const out = await polishAll([cue(0, '原文 0'), cue(1, '原文 1')]);

    expect(out[0]!.text).toBe('润色 0');
    expect(out[1]!.text).toBe('原文 1');
  });

  it('throws CANCELED when the signal aborts between batches', async () => {
    chatMock.mockImplementation(async () => chatResult('[]'));
    const ac = new AbortController();
    ac.abort();
    // 26 cues → 2 batches; the first loop pass checks the signal.
    await expect(
      polishAll(Array.from({ length: 26 }, (_, i) => cue(i)), { signal: ac.signal }),
    ).rejects.toThrow('CANCELED');
  });
});
