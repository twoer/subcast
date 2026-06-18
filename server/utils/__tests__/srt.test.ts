/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { serializeSrt, serializeBilingualSrt } from '../srt';
import type { Cue } from '../vtt';

const c = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('serializeSrt', () => {
  it('emits 1-indexed cues with SRT timestamps and blank-line separator', () => {
    const cues = [
      c(0, 3240, 'Hello world.'),
      c(3240, 6500, 'This is a test.'),
    ];
    expect(serializeSrt(cues)).toBe(
      '1\n' +
      '00:00:00,000 --> 00:00:03,240\n' +
      'Hello world.\n' +
      '\n' +
      '2\n' +
      '00:00:03,240 --> 00:00:06,500\n' +
      'This is a test.\n' +
      '\n',
    );
  });

  it('preserves cue-internal newlines', () => {
    const out = serializeSrt([c(0, 1000, 'line one\nline two')]);
    expect(out).toContain('line one\nline two\n\n');
  });

  it('handles empty input', () => {
    expect(serializeSrt([])).toBe('');
  });
});

describe('serializeBilingualSrt', () => {
  it('stacks original above translated within each cue', () => {
    const original = [c(0, 1000, 'Hello'), c(1000, 2000, 'World')];
    const translated = [c(0, 1000, '你好'), c(1000, 2000, '世界')];
    expect(serializeBilingualSrt(original, translated)).toBe(
      '1\n' +
      '00:00:00,000 --> 00:00:01,000\n' +
      'Hello\n你好\n' +
      '\n' +
      '2\n' +
      '00:00:01,000 --> 00:00:02,000\n' +
      'World\n世界\n' +
      '\n',
    );
  });

  it('throws when cue counts differ', () => {
    expect(() =>
      serializeBilingualSrt([c(0, 1000, 'a')], [c(0, 1000, 'b'), c(1000, 2000, 'c')]),
    ).toThrow(/cue count/i);
  });

  it('throws when timestamps differ', () => {
    expect(() =>
      serializeBilingualSrt([c(0, 1000, 'a')], [c(0, 1500, 'b')]),
    ).toThrow(/timestamp/i);
  });

  it('returns empty string for empty input', () => {
    expect(serializeBilingualSrt([], [])).toBe('');
  });
});
