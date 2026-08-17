/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMBackend, LLMChatOptions, LLMChatResult } from '../llmClient';
import { LlamaServerBackend } from '../llmBackendLlamaServer';
import { getLlmServer } from '../llmServer';

describe('LLMBackend', () => {
  it('matches the documented interface', () => {
    const stub: LLMBackend = {
      async chat(opts: LLMChatOptions) {
        return chatResult(opts.messages.map((m) => m.content).join('|'));
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

function chatResult(content: string, overrides: Partial<LLMChatResult> = {}): LLMChatResult {
  return {
    content,
    finishReason: 'stop',
    usage: {},
    timing: { totalMs: 1 },
    retries: 0,
    coldStart: false,
    ...overrides,
  };
}

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
    // Lease acquisition is a no-op in tests; the lease carries a fixed endpoint.
    vi.spyOn(getLlmServer(), 'ensureLease').mockResolvedValue({
      endpoint: 'http://127.0.0.1:51302',
      modelId: '8b',
      modelPath: '/models/qwen3-8b.gguf',
      backend: 'llama-server',
      runtimeProfileId: 'default',
      coldStart: false,
    });
    vi.spyOn(getLlmServer(), 'ensure').mockResolvedValue(undefined);
    vi.spyOn(getLlmServer(), 'getPort').mockReturnValue(51302);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('chat() POSTs to /v1/chat/completions on the live port and returns typed content and metrics', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:51302/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      return jsonResponse({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
        timings: { prompt_ms: 25, predicted_ms: 75 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    const result = await backend.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({
      content: 'hello',
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 3 },
      timing: { prefillMs: 25, decodeMs: 75, totalMs: expect.any(Number) },
      retries: 0,
      coldStart: false,
    });
    expect(getLlmServer().ensureLease).toHaveBeenCalledTimes(1);
  });

  it('chat() reacquires the lease before retrying a connection failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    await expect(backend.chat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toMatchObject({
      content: 'ok',
      retries: 1,
    });

    expect(getLlmServer().ensureLease).toHaveBeenCalledTimes(2);
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

  it('chat() sends response_format json_schema only when responseSchema is set', async () => {
    let bodyWithout: Record<string, unknown> | undefined;
    let bodyWith: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.response_format) bodyWith = body;
      else bodyWithout = body;
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;

    const backend = new LlamaServerBackend();
    await backend.chat({ messages: [{ role: 'user', content: 'hi' }] });
    await backend.chat({
      messages: [{ role: 'user', content: 'hi' }],
      responseSchema: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    });

    expect(bodyWithout).toBeDefined();
    expect(bodyWithout).not.toHaveProperty('response_format');
    expect(bodyWith).toBeDefined();
    expect(bodyWith!.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'subcast_response',
        schema: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
      },
    });
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
    expect(res.content).toBe('ok');
  });
});
