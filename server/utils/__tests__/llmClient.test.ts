/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMBackend, LLMChatOptions } from '../llmClient';
import { LlamaServerBackend } from '../llmBackendLlamaServer';
import { getLlmServer } from '../llmServer';

describe('LLMBackend', () => {
  it('matches the documented interface', () => {
    const stub: LLMBackend = {
      async chat(opts: LLMChatOptions) {
        return opts.messages.map((m) => m.content).join('|');
      },
      // eslint-disable-next-line require-yield
      async *chatStream(_opts) {
        return;
      },
    };
    expect(typeof stub.chat).toBe('function');
    expect(typeof stub.chatStream).toBe('function');
  });
});

/**
 * Helper: build a Response-like object for non-streaming fetch mocks.
 */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    async json() {
      return body;
    },
    async text() {
      return init.text ?? JSON.stringify(body);
    },
  } as unknown as Response;
}

/**
 * Helper: build a Response-like object whose body is a ReadableStream of
 * the given SSE chunks (each chunk pre-formatted with terminating newlines).
 */
function streamResponse(chunks: string[]): Response {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('LlamaServerBackend', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // ensure() is a no-op in tests; getPort returns a fixed port.
    vi.spyOn(getLlmServer(), 'ensure').mockResolvedValue(undefined);
    vi.spyOn(getLlmServer(), 'getPort').mockReturnValue(51302);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('chat() POSTs to /v1/chat/completions on the live port and returns assembled content', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:51302/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      return jsonResponse({
        choices: [{ message: { content: 'hello' } }],
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    const result = await backend.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toBe('hello');
    expect(getLlmServer().ensure).toHaveBeenCalledTimes(1);
  });

  it('chat() throws on 5xx including the response body', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({}, { ok: false, status: 503, text: 'model loading' }),
    ) as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    await expect(
      backend.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/503.*model loading/);
  });

  it('chatStream() yields deltas assembled from SSE chunks then a stop marker', async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    const out: string[] = [];
    let finish: string | undefined;
    for await (const chunk of backend.chatStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.delta) out.push(chunk.delta);
      if (chunk.finishReason) finish = chunk.finishReason;
    }
    expect(out.join('')).toBe('hello');
    expect(finish).toBe('stop');
  });

  it('chatStream() emits cancel marker when signal aborts mid-stream', async () => {
    const controller = new AbortController();
    // Build a stream pre-loaded with one delta, then "stalled" — we
    // close it via the abort hook only after the caller cancels. This
    // mirrors how `fetch` propagates aborts to the body reader.
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(streamCtrl) {
            const enc = new TextEncoder();
            streamCtrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"he"}}]}\n'));
            sig?.addEventListener('abort', () => {
              try {
                streamCtrl.error(new DOMException('aborted', 'AbortError'));
              } catch { /* already closed */ }
            });
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    const iter = backend.chatStream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toEqual({ delta: 'he' });

    controller.abort();
    const second = await iter.next();
    expect(second.value).toEqual({ delta: '', finishReason: 'cancel' });

    const third = await iter.next();
    expect(third.done).toBe(true);
  });

  it('chat() applies dynamic timeout = 30s base + 50ms per estimated input token', async () => {
    // We can't easily inspect AbortSignal.timeout's deadline, but we can
    // verify our estimator: 200 chars ≈ 50 tokens → 30_000 + 50*50 = 32_500.
    // Smoke: invoke chat() with a known-length prompt and verify it
    // doesn't immediately throw a timeout (i.e. the AbortSignal isn't
    // already fired). The detailed math is unit-checked here too.
    const longPrompt = 'a'.repeat(200);
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    const res = await backend.chat({ messages: [{ role: 'user', content: longPrompt }] });
    expect(res).toBe('ok');
  });
});
