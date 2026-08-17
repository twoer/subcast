/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlamaServerBackend } from '../llmBackendLlamaServer';
import { getLlmServer } from '../llmServer';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  } as unknown as Response;
}

const OK_BODY = { choices: [{ message: { content: 'hello' } }] };

describe('LlamaServerBackend transient retry', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
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

  it('chat() retries a connection failure (server mid-respawn) and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    await expect(backend.chat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toMatchObject({
      content: 'hello',
      retries: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('chat() retries a 503 and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('busy', 503))
      .mockResolvedValueOnce(jsonResponse(OK_BODY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    await expect(backend.chat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toMatchObject({
      content: 'hello',
      retries: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('chat() does NOT retry 4xx — fails fast with the body surfaced', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('bad request', 400));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    await expect(
      backend.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/400: bad request/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chat() reports the given-up 5xx to the server health tracker', async () => {
    const noteHttpFailure = vi
      .spyOn(getLlmServer(), 'noteHttpFailure')
      .mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('boom', 500));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    await expect(
      backend.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/500: boom/);
    // 1 initial + 2 retries, then reported once on give-up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(noteHttpFailure).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('chatStream() retries a pre-response 503, then streams normally', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const streamResponse = {
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('busy', 503))
      .mockResolvedValueOnce(streamResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    const got: string[] = [];
    for await (const c of backend.chatStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (c.delta) got.push(c.delta);
    }
    expect(got.join('')).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
