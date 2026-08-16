/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { migrateLegacySettings } from '../settings';

describe('migrateLegacySettings', () => {
  it('drops the legacy ollamaModel field', () => {
    const result = migrateLegacySettings({
      whisperModel: 'small',
      ollamaModel: 'qwen2.5:7b',
      cacheLimitGB: 10,
      silenceThresholdMs: 10_000,
      debugMode: false,
    } as Record<string, unknown>);
    expect('ollamaModel' in result).toBe(false);
    expect((result as { llmModel?: string }).llmModel).toBeUndefined();
  });

  it('persists migration hint for the wizard', () => {
    const result = migrateLegacySettings({ ollamaModel: 'qwen2.5:14b' } as Record<string, unknown>);
    expect((result as { _migrationHint?: string })._migrationHint).toBe('14b');
  });

  it('hint is undefined when legacy tag is unrecognised', () => {
    const result = migrateLegacySettings({ ollamaModel: 'llama3.1:8b' } as Record<string, unknown>);
    expect((result as { _migrationHint?: string })._migrationHint).toBeUndefined();
  });

  it('preserves other fields unchanged when no legacy field present', () => {
    const result = migrateLegacySettings({
      whisperModel: 'base',
      cacheLimitGB: 20,
      debugMode: true,
    } as Record<string, unknown>);
    expect(result).toEqual({
      whisperModel: 'base',
      cacheLimitGB: 20,
      debugMode: true,
    });
  });

  // --- Qwen2.5 → Qwen3 tier remap -------------------------------------

  it('remaps stored Qwen2.5 llmModel tiers to Qwen3 equivalents', () => {
    const result = migrateLegacySettings({ llmModel: '3b' } as Record<string, unknown>);
    expect((result as { llmModel?: string }).llmModel).toBe('4b');
    const result2 = migrateLegacySettings({ llmModel: '7b' } as Record<string, unknown>);
    expect((result2 as { llmModel?: string }).llmModel).toBe('8b');
  });

  it('keeps already-current Qwen3 tier ids unchanged', () => {
    for (const id of ['4b', '8b', '14b']) {
      const result = migrateLegacySettings({ llmModel: id } as Record<string, unknown>);
      expect((result as { llmModel?: string }).llmModel).toBe(id);
    }
  });

  it('remaps the 0.1 Ollama hint through the same table', () => {
    const result = migrateLegacySettings({ ollamaModel: 'qwen2.5:7b' } as Record<string, unknown>);
    expect((result as { _migrationHint?: string })._migrationHint).toBe('8b');
  });

  it('accepts qwen3-prefixed Ollama tags directly', () => {
    const result = migrateLegacySettings({ ollamaModel: 'qwen3:8b' } as Record<string, unknown>);
    expect((result as { _migrationHint?: string })._migrationHint).toBe('8b');
  });

  it('drops unknown llmModel values so defaults apply', () => {
    const result = migrateLegacySettings({ llmModel: '42b' } as Record<string, unknown>);
    expect('llmModel' in result).toBe(false);
  });
});
