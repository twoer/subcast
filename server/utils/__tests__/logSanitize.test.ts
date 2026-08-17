/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { sanitizeLine, sanitizeUserErrorMessage } from '../logSanitize';

describe('sanitizeLine', () => {
  it('passes through unchanged when debug=true', () => {
    const line = JSON.stringify({ event: 'x', path: '/Users/alice/secret.mp4' });
    expect(sanitizeLine(line, true)).toBe(line);
  });

  it('redacts *path* fields when debug=false', () => {
    const out = sanitizeLine(
      JSON.stringify({ event: 'x', path: '/Users/alice/secret.mp4' }),
      false,
    );
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.event).toBe('x');
    expect(parsed.path).toMatch(/^hash:[0-9a-f]{12}$/);
  });

  it('redacts *name* fields when debug=false', () => {
    const out = sanitizeLine(
      JSON.stringify({ event: 'x', filename: 'my-private-video.mkv' }),
      false,
    );
    expect(JSON.parse(out).filename).toMatch(/^hash:[0-9a-f]{12}$/);
  });

  it('redacts content-bearing model fields when debug=false', () => {
    const out = sanitizeLine(
      JSON.stringify({
        event: 'translate_count_mismatch',
        rawPreview: '模型输出片段',
        cueText: '用户字幕原文',
        promptText: '完整提示词',
        transcriptText: '完整转写文本',
        modelOutput: '完整模型输出',
      }),
      false,
    );
    const parsed = JSON.parse(out) as Record<string, string>;
    expect(parsed.rawPreview).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(parsed.cueText).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(parsed.promptText).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(parsed.transcriptText).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(parsed.modelOutput).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(out).not.toContain('用户字幕原文');
  });

  it('keeps safe passthrough fields verbatim', () => {
    const line = JSON.stringify({
      ts: 123,
      level: 'info',
      event: 'foo',
      taskId: 't-1',
      sha: 'abc',
      lang: 'zh',
      msg: 'hello',
      code: 'OK',
      requestId: 'r-1',
    });
    expect(sanitizeLine(line, false)).toBe(line);
  });

  it('keeps msg text but redacts embedded absolute paths', () => {
    const out = sanitizeLine(
      JSON.stringify({
        event: 'spawn_error',
        msg: 'failed to open /Users/alice/dev/subcast/input.mp4',
      }),
      false,
    );
    const parsed = JSON.parse(out) as Record<string, string>;
    expect(parsed.msg).toContain('failed to open ');
    expect(parsed.msg).not.toContain('/Users/alice');
    expect(parsed.msg).toMatch(/path:[0-9a-f]{12}/);
  });

  it('redacts tilde-prefixed paths in user-facing errors', () => {
    const out = sanitizeUserErrorMessage(
      "failed to load model '~/Documents/Code/subcast/.dev-userdata/models/llm/Qwen3-4B-Q4_K_M.gguf'",
    );

    expect(out).toContain('failed to load model ');
    expect(out).not.toContain('~/Documents');
    expect(out).not.toContain('Qwen3-4B-Q4_K_M.gguf');
    expect(out).toMatch(/path:[0-9a-f]{12}/);
  });

  it('redacts absolute paths embedded in stderr text fields', () => {
    const out = sanitizeLine(
      JSON.stringify({
        event: 'spawn_exit',
        stderrTail:
          "dyld: Library not loaded: /Users/alice/dev/subcast/node_modules/x/lib.dylib, referenced from /System/Volumes/Preboot/Cryptexes/OS/Users/alice/dev/subcast/node_modules/x/lib.dylib",
      }),
      false,
    );
    const parsed = JSON.parse(out) as Record<string, string>;
    expect(parsed.stderrTail).not.toContain('/Users/alice');
    expect(parsed.stderrTail).not.toContain('/System/Volumes');
    expect(parsed.stderrTail).toMatch(/path:[0-9a-f]{12}/);
  });

  it('sanitizes raw non-JSON lines too', () => {
    expect(sanitizeLine('not json /Users/alice/secret.mp4', false)).toMatch(
      /^not json path:[0-9a-f]{12}$/,
    );
  });

  it('produces deterministic hashes for the same input', () => {
    const a = sanitizeLine(JSON.stringify({ path: '/a/b/c.mp4' }), false);
    const b = sanitizeLine(JSON.stringify({ path: '/a/b/c.mp4' }), false);
    expect(a).toBe(b);
  });
});
