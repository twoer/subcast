/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { describe, it, expect } from 'vitest';
import { sanitizeLine } from '../logSanitize';

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

  it('keeps passthrough fields (taskId, sha, msg, etc.) verbatim', () => {
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

  it('returns the raw line unchanged when it is not JSON', () => {
    expect(sanitizeLine('not json', false)).toBe('not json');
  });

  it('produces deterministic hashes for the same input', () => {
    const a = sanitizeLine(JSON.stringify({ path: '/a/b/c.mp4' }), false);
    const b = sanitizeLine(JSON.stringify({ path: '/a/b/c.mp4' }), false);
    expect(a).toBe(b);
  });
});
