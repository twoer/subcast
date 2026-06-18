/* SPDX-License-Identifier: Apache-2.0 */

import { describe, it, expect } from 'vitest';
import { LLM_MODELS, llmDownloadUrl, recommendLlmModel } from '../llmConfig';

describe('llmConfig', () => {
  it('exposes 3B / 7B / 14B with monotonic size', () => {
    const ids = ['3b', '7b', '14b'] as const;
    const sizes = ids.map((id) => LLM_MODELS[id].sizeBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('hf-mirror URL contains hf-mirror.com', () => {
    expect(llmDownloadUrl('7b', 'hf-mirror')).toContain('hf-mirror.com');
  });

  it('recommendLlmModel maps tier ranges correctly', () => {
    expect(recommendLlmModel({ totalMemoryGB: 4 })).toBe('3b');
    expect(recommendLlmModel({ totalMemoryGB: 16 })).toBe('7b');
    expect(recommendLlmModel({ totalMemoryGB: 64 })).toBe('14b');
  });
});
