/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { describe, it, expect } from 'vitest';
import type { LLMBackend, LLMChatOptions } from '../llmClient';

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
