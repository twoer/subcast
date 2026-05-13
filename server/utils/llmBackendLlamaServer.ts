/* SPDX-License-Identifier: AGPL-3.0-or-later */
import type { LLMBackend, LLMChatOptions, LLMChunk } from './llmClient';

/**
 * HTTP client for the llama-server sidecar (OpenAI-compatible API).
 * Real implementation lands in Task 1.4; this stub keeps the
 * factory in llmClient.ts compilable while the abstraction is in place.
 */
export class LlamaServerBackend implements LLMBackend {
  chat(_opts: LLMChatOptions): Promise<string> {
    throw new Error('LlamaServerBackend.chat not yet implemented');
  }
  // eslint-disable-next-line require-yield
  async *chatStream(_opts: LLMChatOptions): AsyncIterable<LLMChunk> {
    throw new Error('LlamaServerBackend.chatStream not yet implemented');
  }
}
