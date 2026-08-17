/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';

import {
  benchmarkFixtureHash,
  buildModelBenchmarkReport,
  scoreBenchmarkResult,
  shapeModelBenchmarkResult,
} from '../modelBenchmark';

describe('modelBenchmark', () => {
  const fixture = {
    id: 'translate.zh-CN.synthetic.short',
    task: 'translate',
    input: {
      cues: [
        'A private raw fixture sentence that must never be copied into reports.',
        'Synthetic subtitle text for benchmark input only.',
      ],
    },
  };

  it('hashes fixtures without copying raw fixture text into result metadata', () => {
    const result = shapeModelBenchmarkResult({
      modelId: '8b',
      task: 'translate',
      ok: true,
      durationMs: 1200,
      promptTokens: 40,
      completionTokens: 20,
      jsonValid: true,
    });

    const report = buildModelBenchmarkReport([result], '2026-08-17T00:00:00.000Z');
    const serialized = JSON.stringify({
      fixtureHash: benchmarkFixtureHash(fixture),
      report,
    });

    expect(serialized).not.toContain('private raw fixture sentence');
    expect(serialized).not.toContain('Synthetic subtitle text');
    expect(serialized).not.toContain('benchmark input only');
  });

  it('keeps report metadata free of local paths', () => {
    const report = buildModelBenchmarkReport([
      shapeModelBenchmarkResult({
        modelId: '8b',
        task: 'polish',
        ok: false,
        durationMs: 10,
        error: new Error('/Users/example/Documents/Code/input.vtt'),
      }),
    ]);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/Documents\/Code/);
    expect(serialized).not.toMatch(/input\.vtt/);
  });

  it('includes the safe benchmark result schema fields', () => {
    const result = shapeModelBenchmarkResult({
      modelId: '14b',
      task: 'insight',
      ok: true,
      durationMs: 2500,
      promptTokens: 100,
      completionTokens: 50,
      jsonValid: false,
    });

    expect(result).toMatchObject({
      modelId: '14b',
      task: 'insight',
      ok: true,
      durationMs: 2500,
      promptTokens: 100,
      completionTokens: 50,
      tokensPerSecond: 20,
      jsonValid: false,
      score: expect.any(Number),
    });
  });

  it('records an error class without recording the error message', () => {
    const result = shapeModelBenchmarkResult({
      modelId: '4b',
      task: 'insight-map',
      ok: false,
      durationMs: 1,
      error: new TypeError('raw model output and local path /Users/example/file.vtt'),
    });

    expect(result.errorClass).toBe('TypeError');
    expect(JSON.stringify(result)).not.toContain('raw model output');
    expect(JSON.stringify(result)).not.toContain('/Users/example');
  });

  it('scores deterministically', () => {
    const input = {
      ok: true,
      durationMs: 1800,
      jsonValid: true,
      tokensPerSecond: 18.2,
    };

    expect(scoreBenchmarkResult(input)).toBe(scoreBenchmarkResult(input));
  });
});
