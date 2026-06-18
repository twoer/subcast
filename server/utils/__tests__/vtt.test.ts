/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { serializeBilingualVtt } from '../vtt';
import type { Cue } from '../vtt';

const c = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('serializeBilingualVtt', () => {
  it('emits a single VTT with original on top and translated below per cue', () => {
    const original = [c(0, 1000, 'Hello'), c(1000, 2000, 'World')];
    const translated = [c(0, 1000, '你好'), c(1000, 2000, '世界')];
    expect(serializeBilingualVtt(original, translated)).toBe(
      'WEBVTT\n\n' +
      '00:00:00.000 --> 00:00:01.000\n' +
      'Hello\n你好\n\n' +
      '00:00:01.000 --> 00:00:02.000\n' +
      'World\n世界\n',
    );
  });

  it('throws when cue counts differ', () => {
    expect(() =>
      serializeBilingualVtt([c(0, 1000, 'a')], []),
    ).toThrow(/cue count/i);
  });

  it('throws when timestamps differ', () => {
    expect(() =>
      serializeBilingualVtt([c(0, 1000, 'a')], [c(0, 999, 'b')]),
    ).toThrow(/timestamp/i);
  });

  it('returns header-only string for empty input', () => {
    expect(serializeBilingualVtt([], [])).toBe('WEBVTT\n');
  });
});
