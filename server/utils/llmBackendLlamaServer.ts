/* SPDX-License-Identifier: Apache-2.0 */
import type { LLMBackend, LLMChatOptions, LLMChatResult, LLMChunk, LLMFinishReason } from './llmClient';
import { getLlmServer, type ModelLease } from './llmServer';
import { stripThinkBlocks, ThinkStreamFilter } from './thinkFilter';

/**
 * Disables Qwen3's default `<think>` reasoning at the chat-template
 * level. llama-server (>= 2025-05) forwards this kwarg into the GGUF's
 * embedded template. Belt-and-suspenders: even when the server ignores
 * it, `thinkFilter.ts` strips leaked think blocks from content — and
 * reasoning surfaced via the separate `reasoning_content` field is
 * never read in the first place.
 */
const DISABLE_THINKING_KWARGS = { chat_template_kwargs: { enable_thinking: false } };

/**
 * Dynamic-timeout knobs.
 *
 * Inference cost is dominated by the *output* token count (~30-50 tok/s
 * on M-series 7B Q4), not input — but a long prompt also has a non-
 * trivial prefill cost. We budget for the larger of `input_tokens` and
 * `maxTokens`, plus a 30 s baseline for spawn warmup / KV cache prep.
 *
 * For a typical AI Insights call (~5 k input chars ≈ 1.25 k tokens,
 * `maxTokens=4096`) this comes to 30 s + 4096 × 50 ms ≈ 235 s — a
 * generous-but-bounded cap that won't trip on legitimate long generations
 * yet still fails fast on a wedged server.
 *
 * Values are constants (not env-driven) intentionally — getting these
 * wrong is rare enough that a code change + redeploy is the right
 * cadence for tuning.
 */
const DEFAULT_TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_TOKEN_MS = 50;
/** Approximation: 4 chars/token (cl100k-style); good enough for budgeting. */
const CHARS_PER_TOKEN = 4;
/** Fallback for callers that don't pass maxTokens — matches our chat() default. */
const DEFAULT_MAX_TOKENS = 2048;

function estimateInputTokens(opts: LLMChatOptions): number {
  const chars = opts.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function dynamicTimeoutMs(opts: LLMChatOptions): number {
  const inputTokens = estimateInputTokens(opts);
  const outputBudget = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Use whichever of {prefill, generation} dominates wall time.
  const dominantTokens = Math.max(inputTokens, outputBudget);
  return DEFAULT_TIMEOUT_BASE_MS + dominantTokens * TIMEOUT_PER_TOKEN_MS;
}

/**
 * Build the URL for an OpenAI-compatible endpoint on the live llama-server.
 * Must only be called *after* `getLlmServer().ensure()` resolves so that
 * `getPort()` has a value.
 */
function endpoint(lease: ModelLease, path: string): string {
  return `${lease.endpoint}${path}`;
}

/**
 * Compose the AbortSignal we hand to fetch: the caller-supplied signal
 * (if any) takes priority and we layer a dynamic-timeout on top.
 * AbortSignal.any returns a signal that aborts when *any* input aborts.
 */
function composeSignal(opts: LLMChatOptions): AbortSignal {
  const timeoutSig = AbortSignal.timeout(dynamicTimeoutMs(opts));
  if (!opts.signal) return timeoutSig;
  // AbortSignal.any is Node 20+; safe in Nitro.
  return AbortSignal.any([opts.signal, timeoutSig]);
}

interface ChatChoice {
  /**
   * Reasoning tokens on Qwen3 thinking-mode responses. Deliberately
   * never read — we only consume `content`.
   */
  reasoning_content?: string;
  message?: { content?: string };
  delta?: { content?: string };
  finish_reason?: string | null;
}
interface ChatResponseBody {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  timings?: {
    prompt_ms?: number;
    predicted_ms?: number;
  };
}

/**
 * Shared request body for chat/chatStream. When `responseSchema` is set,
 * constrain decoding via llama-server's json_schema response_format
 * (GBNF grammar) — the model physically cannot emit anything that
 * violates the schema, which is what lets translate/polish trust
 * attempt 1 instead of descending the count-mismatch retry ladder.
 */
function buildBody(opts: LLMChatOptions, stream: boolean): Record<string, unknown> {
  return {
    model: 'subcast-local',
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0.2,
    stream,
    ...DISABLE_THINKING_KWARGS,
    ...(opts.responseSchema
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'subcast_response', schema: opts.responseSchema },
          },
        }
      : {}),
  };
}

/**
 * Short backoff ladder for transient failures: connection resets while
 * llama-server is mid-respawn (model switch, crash-restart, idle reload)
 * and 5xx blips. Deliberately does NOT retry timeouts — a wedged server
 * would just multiply the wall time; the caller's ladder handles those.
 */
const TRANSIENT_RETRY_DELAYS_MS = [250, 1_000];

/**
 * undici surfaces connection-level failures (ECONNREFUSED, ECONNRESET,
 * socket hangup) as TypeError('fetch failed'); AbortSignal.timeout
 * surfaces TimeoutError. Only the former is transient.
 */
function isConnectionFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when another retry is allowed (budget left and not aborted). */
function canRetry(opts: LLMChatOptions, attempt: number): boolean {
  return attempt < TRANSIENT_RETRY_DELAYS_MS.length && !opts.signal?.aborted;
}

function normalizeFinishReason(reason: string | null | undefined): LLMFinishReason | undefined {
  if (reason === 'stop' || reason === 'length') return reason;
  if (reason === 'cancel' || reason === 'error') return reason;
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * HTTP client for the llama-server sidecar (OpenAI-compatible API).
 * Lazy-spawns / re-uses the sidecar via `getLlmServer().ensure()` before
 * every request — both methods are safe to call without manual lifecycle
 * coordination.
 */
export class LlamaServerBackend implements LLMBackend {
  async chat(opts: LLMChatOptions): Promise<LLMChatResult> {
    let lease = await getLlmServer().ensureLease({ modelId: opts.modelId });
    let coldStart = lease.coldStart;
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(endpoint(lease, '/v1/chat/completions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildBody(opts, false)),
          signal: composeSignal(opts),
        });
      } catch (err) {
        if (isConnectionFailure(err) && canRetry(opts, attempt)) {
          await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
          lease = await getLlmServer().ensureLease({ modelId: opts.modelId });
          coldStart ||= lease.coldStart;
          continue;
        }
        throw err;
      }
      if (!res.ok) {
        // Surface the response body so callers can distinguish e.g. OOM
        // ("ggml_metal_graph_compute: ...") from other 5xx and react.
        const text = await res.text().catch(() => '<no body>');
        if (res.status >= 500 && canRetry(opts, attempt)) {
          await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
          lease = await getLlmServer().ensureLease({ modelId: opts.modelId });
          coldStart ||= lease.coldStart;
          continue;
        }
        if (res.status >= 500) getLlmServer().noteHttpFailure();
        throw new Error(`llama-server returned ${res.status}: ${text}`);
      }
      const body = (await res.json()) as ChatResponseBody;
      // Natural completion — clear the consecutive-failure counter so a
      // single recovered crash earlier in the session doesn't latch us into
      // MODEL_UNUSABLE on the next spawn cycle.
      getLlmServer().noteSuccess();
      return {
        content: stripThinkBlocks(body.choices?.[0]?.message?.content ?? ''),
        finishReason: normalizeFinishReason(body.choices?.[0]?.finish_reason),
        usage: {
          promptTokens: optionalNumber(body.usage?.prompt_tokens),
          completionTokens: optionalNumber(body.usage?.completion_tokens),
        },
        timing: {
          prefillMs: optionalNumber(body.timings?.prompt_ms),
          decodeMs: optionalNumber(body.timings?.predicted_ms),
          totalMs: Date.now() - startedAt,
        },
        retries: attempt,
        coldStart,
      };
    }
  }

  async *chatStream(opts: LLMChatOptions): AsyncIterable<LLMChunk> {
    let lease = await getLlmServer().ensureLease({ modelId: opts.modelId });
    // Retry only PRE-response failures — once the SSE stream has started
    // delivering bytes, a mid-stream break cannot be transparently
    // replayed to the consumer.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(endpoint(lease, '/v1/chat/completions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildBody(opts, true)),
          signal: composeSignal(opts),
        });
      } catch (err) {
        if (isConnectionFailure(err) && canRetry(opts, attempt)) {
          await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
          lease = await getLlmServer().ensureLease({ modelId: opts.modelId });
          continue;
        }
        throw err;
      }
      if (res.ok && res.body) break;
      const text = res.body ? await res.text().catch(() => '<no body>') : '<no body>';
      if (res.status >= 500 && canRetry(opts, attempt)) {
        await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
        lease = await getLlmServer().ensureLease({ modelId: opts.modelId });
        continue;
      }
      if (res.status >= 500) getLlmServer().noteHttpFailure();
      throw new Error(`llama-server stream returned ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Drops any `<think>…</think>` block that leaks into content deltas
    // despite DISABLE_THINKING_KWARGS (marker may straddle deltas).
    const thinkFilter = new ThinkStreamFilter();
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          // Stream errored — most commonly because the caller-supplied
          // signal aborted. Yield the synthetic cancel marker per spec
          // before re-throwing or returning, depending on whether this
          // was the user's abort or an actual network failure.
          if (opts.signal?.aborted) {
            yield { delta: '', finishReason: 'cancel' };
            return;
          }
          throw err;
        }
        const { value, done } = chunk;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            // Treat [DONE] as natural stop and reset the failure counter —
            // a server that streams to completion is healthy regardless of
            // whether an explicit `finish_reason: stop` event preceded it.
            getLlmServer().noteSuccess();
            yield { delta: thinkFilter.flush(), finishReason: 'stop' };
            return;
          }
          let parsed: ChatResponseBody;
          try {
            parsed = JSON.parse(payload) as ChatResponseBody;
          } catch {
            // Malformed SSE event — skip and keep going. llama-server
            // occasionally emits keep-alive lines we don't care about.
            continue;
          }
          const choice = parsed.choices?.[0];
          const rawDelta = choice?.delta?.content ?? '';
          const delta = rawDelta ? thinkFilter.push(rawDelta) : '';
          const finish = choice?.finish_reason;
          const finishReason: LLMChunk['finishReason'] =
            finish === 'length' ? 'length' : finish === 'stop' ? 'stop' : undefined;
          if (finishReason) {
            const tail = thinkFilter.flush();
            const merged = delta + tail;
            // Only `'stop'` (natural completion) counts as success — a
            // `'length'` finish means we hit max_tokens, which still
            // indicates a healthy server but the spec calls for resetting
            // the counter only on natural stop per Task 1.5.
            if (finishReason === 'stop') {
              getLlmServer().noteSuccess();
            }
            yield { delta: merged, finishReason };
            return;
          }
          if (delta) {
            yield { delta };
          }
        }
      }
    } finally {
      // Best-effort: release the reader so the underlying connection
      // can be reused. Ignore errors — the stream may already be closed.
      try { reader.releaseLock(); } catch { /* noop */ }
    }
  }
}
