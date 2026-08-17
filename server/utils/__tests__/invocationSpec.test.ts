/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';

import {
  buildInsightInvocationSpec,
  buildPolishInvocationSpec,
  buildTranslateInvocationSpec,
  hashInvocationHint,
  invocationFingerprint,
} from '../invocationSpec';

describe('InvocationSpec', () => {
  it('builds a deterministic translate spec', () => {
    const a = buildTranslateInvocationSpec({
      modelId: '8b',
      sourceRevision: 'transcript:abc',
      language: 'zh-CN',
    });
    const b = buildTranslateInvocationSpec({
      modelId: '8b',
      sourceRevision: 'transcript:abc',
      language: 'zh-CN',
    });

    expect(a).toEqual(b);
    expect(a).toMatchObject({
      kind: 'translate',
      modelId: '8b',
      backend: 'llama-server',
      promptVersion: expect.any(String),
      schemaVersion: expect.any(String),
      sourceRevision: 'transcript:abc',
      language: 'zh-CN',
      generation: {
        temperature: 0,
        responseSchemaName: 'json-string-array',
      },
    });
  });

  it('builds a polish spec without storing raw hints', () => {
    const hints = 'Private guest name: Alice Example';
    const spec = buildPolishInvocationSpec({
      modelId: '4b',
      sourceRevision: 'transcript:def',
      hints,
    });

    expect(spec.kind).toBe('polish');
    expect(spec.hintsHash).toBe(hashInvocationHint(hints));
    expect(JSON.stringify(spec)).not.toContain(hints);
    expect(JSON.stringify(spec)).not.toContain('Alice Example');
  });

  it('builds an insight spec with max token budget', () => {
    const spec = buildInsightInvocationSpec({
      modelId: '14b',
      sourceRevision: 'transcript:ghi',
      uiLanguage: 'en',
    });

    expect(spec).toMatchObject({
      kind: 'insight',
      modelId: '14b',
      language: 'en',
      generation: {
        temperature: 0.3,
        maxTokens: 4096,
      },
    });
  });

  it('rejects unknown model ids', () => {
    expect(() =>
      buildInsightInvocationSpec({
        modelId: 'qwen2.5:7b',
        sourceRevision: 'transcript:ghi',
        uiLanguage: 'en',
      }),
    ).toThrow(/UNKNOWN_LLM_MODEL/);
  });

  it('changes fingerprint when spec-relevant fields change', () => {
    const base = buildTranslateInvocationSpec({
      modelId: '8b',
      sourceRevision: 'transcript:abc',
      language: 'zh-CN',
    });
    const same = buildTranslateInvocationSpec({
      modelId: '8b',
      sourceRevision: 'transcript:abc',
      language: 'zh-CN',
    });
    const changedModel = buildTranslateInvocationSpec({
      modelId: '4b',
      sourceRevision: 'transcript:abc',
      language: 'zh-CN',
    });
    const changedSource = buildTranslateInvocationSpec({
      modelId: '8b',
      sourceRevision: 'transcript:changed',
      language: 'zh-CN',
    });

    expect(invocationFingerprint(base)).toBe(invocationFingerprint(same));
    expect(invocationFingerprint(base)).not.toBe(invocationFingerprint(changedModel));
    expect(invocationFingerprint(base)).not.toBe(invocationFingerprint(changedSource));
  });
});

