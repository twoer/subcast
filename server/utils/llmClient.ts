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
}

export interface LLMChunk {
  /** Token delta appended this tick (may be empty). */
  delta: string;
  /** Set on the final chunk only. */
  finishReason?: 'stop' | 'length' | 'cancel';
}

export interface LLMBackend {
  chat(opts: LLMChatOptions): Promise<string>;
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
