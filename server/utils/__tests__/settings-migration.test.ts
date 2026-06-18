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
});
