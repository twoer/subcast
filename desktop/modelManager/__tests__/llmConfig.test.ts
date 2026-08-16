/* SPDX-License-Identifier: Apache-2.0 */

import { describe, it, expect } from 'vitest';
import { LLM_MODELS, llmDownloadUrl, recommendLlmModel } from '../llmConfig';

describe('llmConfig', () => {
  it('exposes 4B / 8B / 14B with monotonic size', () => {
    const ids = ['4b', '8b', '14b'] as const;
    const sizes = ids.map((id) => LLM_MODELS[id].sizeBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('points at the official Qwen3 GGUF repos', () => {
    expect(llmDownloadUrl('4b', 'huggingface')).toBe(
      'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    );
  });

  it('hf-mirror URL contains hf-mirror.com', () => {
    expect(llmDownloadUrl('8b', 'hf-mirror')).toContain('hf-mirror.com');
  });

  it('recommendLlmModel maps tier ranges correctly', () => {
    expect(recommendLlmModel({ totalMemoryGB: 4 })).toBe('4b');
    expect(recommendLlmModel({ totalMemoryGB: 16 })).toBe('8b');
    expect(recommendLlmModel({ totalMemoryGB: 64 })).toBe('14b');
  });
});
