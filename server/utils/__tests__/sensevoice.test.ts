/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, truncateSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  senseVoiceModelDir,
  senseVoiceModelPaths,
  isSenseVoiceReady,
  SenseVoiceSession,
  SENSE_VOICE_MODEL_FILE,
  SENSE_VOICE_TOKENS_FILE,
  stripSenseVoiceTags,
  normalizeSenseVoiceCasing,
  detectDominantLanguage,
  voteLanguage,
} from '../sensevoice';
import { isTranscribeEngine } from '../settings';

describe('senseVoiceModelDir', () => {
  const prevHome = process.env.SUBCAST_HOME;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.SUBCAST_HOME;
    else process.env.SUBCAST_HOME = prevHome;
  });

  it('prefers $SUBCAST_HOME/models/sensevoice when set', () => {
    process.env.SUBCAST_HOME = '/tmp/fake-home';
    expect(senseVoiceModelDir()).toBe(join('/tmp/fake-home', 'models', 'sensevoice'));
  });

  it('falls back to binaries/models/sensevoice in dev', () => {
    delete process.env.SUBCAST_HOME;
    expect(senseVoiceModelDir()).toBe(join(process.cwd(), 'binaries', 'models', 'sensevoice'));
  });
});

describe('isSenseVoiceReady', () => {
  const prevHome = process.env.SUBCAST_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'subcast-sv-'));
    process.env.SUBCAST_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.SUBCAST_HOME;
    else process.env.SUBCAST_HOME = prevHome;
  });

  it('is false when nothing is installed', () => {
    expect(isSenseVoiceReady()).toBe(false);
  });

  it('is false when the model is present but truncated', () => {
    const dir = senseVoiceModelDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SENSE_VOICE_MODEL_FILE), 'x');
    writeFileSync(join(dir, SENSE_VOICE_TOKENS_FILE), 'x');
    expect(isSenseVoiceReady()).toBe(false);
  });

  it('is true when both files exist at plausible sizes', () => {
    const dir = senseVoiceModelDir();
    mkdirSync(dir, { recursive: true });
    // Sparse file: claims 250 MB without allocating it.
    const modelPath = join(dir, SENSE_VOICE_MODEL_FILE);
    writeFileSync(modelPath, 'x');
    truncateSync(modelPath, 250_000_000);
    writeFileSync(join(dir, SENSE_VOICE_TOKENS_FILE), 'a'.repeat(200_000));
    expect(isSenseVoiceReady()).toBe(true);
  });

  it('exposes canonical file names through paths', () => {
    const p = senseVoiceModelPaths();
    expect(p.model.endsWith(SENSE_VOICE_MODEL_FILE)).toBe(true);
    expect(p.tokens.endsWith(SENSE_VOICE_TOKENS_FILE)).toBe(true);
  });
});

describe('SenseVoiceSession.ensure', () => {
  const prevHome = process.env.SUBCAST_HOME;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.SUBCAST_HOME;
    else process.env.SUBCAST_HOME = prevHome;
  });

  it('rejects with SENSE_VOICE_NOT_INSTALLED when the model is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'subcast-sv-'));
    process.env.SUBCAST_HOME = home;
    const session = new SenseVoiceSession();
    await expect(session.ensure()).rejects.toThrow('SENSE_VOICE_NOT_INSTALLED');
    rmSync(home, { recursive: true, force: true });
  });

  it('recognize() rejects before ensure()', async () => {
    const session = new SenseVoiceSession();
    await expect(session.recognize(new Float32Array(16))).rejects.toThrow('not running');
  });
});

describe('isTranscribeEngine', () => {
  it('accepts auto, whisper and sensevoice', () => {
    expect(isTranscribeEngine('auto')).toBe(true);
    expect(isTranscribeEngine('whisper')).toBe(true);
    expect(isTranscribeEngine('sensevoice')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isTranscribeEngine('voxpipe')).toBe(false);
    expect(isTranscribeEngine(undefined)).toBe(false);
    expect(isTranscribeEngine(42)).toBe(false);
  });
});

describe('stripSenseVoiceTags', () => {
  it('removes <|zh|>-style control tokens', () => {
    expect(stripSenseVoiceTags('<|zh|><|NEUTRAL|>你好世界')).toBe('你好世界');
    expect(stripSenseVoiceTags('<|en|>HELLO<|withitn|>')).toBe('HELLO');
  });

  it('leaves clean text untouched', () => {
    expect(stripSenseVoiceTags('普通文本 plain text 123')).toBe('普通文本 plain text 123');
  });
});

describe('normalizeSenseVoiceCasing', () => {
  it('lowercases all-caps English and sentence-cases it', () => {
    expect(normalizeSenseVoiceCasing('HEY TOM I GOT THIS')).toBe('Hey tom i got this');
    expect(normalizeSenseVoiceCasing('HELLO. YES? OK!')).toBe('Hello. Yes? Ok!');
  });

  it('keeps mixed-case text as-is', () => {
    expect(normalizeSenseVoiceCasing('Download Tickets by Truck')).toBe('Download Tickets by Truck');
  });

  it('keeps CJK text untouched', () => {
    expect(normalizeSenseVoiceCasing('今天我们讲一下方案')).toBe('今天我们讲一下方案');
  });
});

describe('detectDominantLanguage / voteLanguage', () => {
  it('detects zh / ja / ko / en from script', () => {
    expect(detectDominantLanguage('今天我们讲一下')).toBe('zh');
    expect(detectDominantLanguage('こんにちは世界')).toBe('ja');
    expect(detectDominantLanguage('안녕하세요')).toBe('ko');
    expect(detectDominantLanguage('HEY TOM')).toBe('en');
    expect(detectDominantLanguage('123')).toBe(null);
  });

  it('kana/hangul win over han ideographs (ja/ko text contains han)', () => {
    expect(detectDominantLanguage('東京タワー')).toBe('ja');
  });

  it('votes majority across samples — the mixed-detect scenario', () => {
    // English dispatch audio where 1 of 3 short segments flipped to zh.
    expect(voteLanguage(['HEY TOM I GOT THIS', 'HOW DO YOU DOWNLOAD', '哦'])).toBe('en');
    // Chinese audio where 1 segment flipped to en.
    expect(voteLanguage(['今天开会', '好的没问题', 'OK'])).toBe('zh');
  });

  it('returns null on no informative samples', () => {
    expect(voteLanguage(['', '123'])).toBe(null);
  });
});
