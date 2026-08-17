/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { parseDetectedLanguage } from '../whisper';

describe('parseDetectedLanguage', () => {
  it('parses the -dl detection line from mixed stdout/stderr noise', () => {
    const out = [
      'whisper_model_load: n_vocab = 51866',
      "main: processing '/tmp/chunk.wav' (480000 samples, 30.0 sec), 4 threads, 1 processors, 5 beams + best of 5, lang = auto, task = transcribe, timestamps = 1 ...",
      'whisper_full_with_state: auto-detected language: en (p = 0.999859)',
      'whisper_print_timings:   total time =   1951.11 ms',
      'ggml_metal_free: deallocating',
    ].join('\n');
    expect(parseDetectedLanguage(out)).toBe('en');
  });

  it('normalizes case and accepts three-letter ids', () => {
    expect(parseDetectedLanguage('auto-detected language: ZH (p = 0.9)')).toBe('zh');
    expect(parseDetectedLanguage('auto-detected language: yue (p = 0.8)')).toBe('yue');
  });

  it('returns null when no detection line is present', () => {
    expect(parseDetectedLanguage('whisper_print_timings: total time = 10 ms')).toBeNull();
    expect(parseDetectedLanguage('')).toBeNull();
  });

  it('does not match language mentions without the detection marker', () => {
    expect(parseDetectedLanguage('lang = auto, language: en-ish noise')).toBeNull();
  });
});
