/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Backend-agnostic LLM client. Business code (insights, translation)
 * only ever depends on `LLMBackend` — the active implementation is
 * selected at module load via `createLLMBackend()`. This makes the
 * future MAS / inline / cloud BYOK migrations a single-file swap.
 *
 * Wire format mirrors OpenAI's Chat Completions API, which llama-server
 * speaks natively and which every other backend can adapt to.
 */

import { LlamaServerBackend } from './llmBackendLlamaServer';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatOptions {
  messages: LLMMessage[];
  /** Hard upper bound on generated tokens; default 2048. */
  maxTokens?: number;
  /** Sampling temperature; default 0.2 for analytical tasks. */
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Constrain decoding to this JSON Schema (llama-server compiles it to a
   * GBNF grammar). Callers demanding a strict output shape — translate /
   * polish's "exactly N strings" array — pass this so count mismatches
   * and parse failures are prevented at generation time instead of
   * triggering the batch-degradation retry ladder.
   */
  responseSchema?: Record<string, unknown>;
}

export interface LLMChunk {
  /** Token delta appended this tick (may be empty). */
  delta: string;
  /** Set on the final chunk only. */
  finishReason?: 'stop' | 'length' | 'cancel';
}

export type LLMFinishReason = 'stop' | 'length' | 'cancel' | 'error';

export interface LLMChatResult {
  content: string;
  finishReason?: LLMFinishReason;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
  };
  timing: {
    prefillMs?: number;
    decodeMs?: number;
    totalMs: number;
  };
  retries: number;
  coldStart?: boolean;
}

export interface LLMBackend {
  chat(opts: LLMChatOptions): Promise<LLMChatResult>;
  chatStream(opts: LLMChatOptions): AsyncIterable<LLMChunk>;
}

export function createLLMBackend(): LLMBackend {
  if (process.env.SUBCAST_BUILD_TARGET === 'mas') {
    throw new Error('mas backend not yet implemented');
  }
  return new LlamaServerBackend();
}

let cached: LLMBackend | null = null;
export function llmBackend(): LLMBackend {
  if (cached === null) cached = createLLMBackend();
  return cached;
}
