/* SPDX-License-Identifier: Apache-2.0 */
import { isLlmModelId, llmDisplayName } from '#shared/llmModels';

/**
 * Queue rows store compact internal model ids. Convert them before rendering
 * so users see the concrete local model tier rather than database keys.
 */
export function displayQueueModel(model: string): string {
  if (isLlmModelId(model)) return llmDisplayName(model);
  switch (model) {
    case 'sensevoice': return 'SenseVoice';
    case 'whisper': return 'Whisper';
    case 'llm': return 'Qwen3';
    default: return model;
  }
}
