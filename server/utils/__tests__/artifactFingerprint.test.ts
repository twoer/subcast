/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';

import {
  artifactFingerprint,
  hashArtifactGenerationOptions,
  hashArtifactSource,
  type ArtifactFingerprintInput,
} from '../artifactFingerprint';

function base(overrides: Partial<ArtifactFingerprintInput> = {}): ArtifactFingerprintInput {
  return {
    kind: 'insight',
    videoSha: 'a'.repeat(64),
    sourceHash: hashArtifactSource('hello transcript'),
    language: 'zh-CN',
    modelId: '8b',
    promptVersion: 'insight-v1',
    schemaVersion: 'insight-markdown-v1',
    generationHash: hashArtifactGenerationOptions({ temperature: 0.3, maxTokens: 4096 }),
    ...overrides,
  };
}

describe('artifactFingerprint', () => {
  it('is deterministic for stable inputs', () => {
    expect(artifactFingerprint(base())).toBe(artifactFingerprint(base()));
  });

  it.each([
    ['sourceHash', { sourceHash: hashArtifactSource('changed transcript') }],
    ['modelId', { modelId: '4b' }],
    ['language', { language: 'en' }],
    ['promptVersion', { promptVersion: 'insight-v2' }],
    ['schemaVersion', { schemaVersion: 'insight-json-v2' }],
    ['generationHash', { generationHash: hashArtifactGenerationOptions({ temperature: 0 }) }],
  ] satisfies Array<[string, Partial<ArtifactFingerprintInput>]>)(
    'changes when %s changes',
    (_name, override) => {
      expect(artifactFingerprint(base(override))).not.toBe(artifactFingerprint(base()));
    },
  );

  it('keeps raw transcript and paths out of the fingerprint input', () => {
    const raw = '/Users/alice/private/video.mp4\n机密 transcript';
    const input = base({ sourceHash: hashArtifactSource(raw) });
    expect(JSON.stringify(input)).not.toContain('/Users/alice');
    expect(JSON.stringify(input)).not.toContain('机密 transcript');
    expect(artifactFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
  });
});
