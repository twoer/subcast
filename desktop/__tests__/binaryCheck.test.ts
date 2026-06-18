/* SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBundledBinaries,
  formatMissingForDialog,
} from '../binaryCheck';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'binaryCheck-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeBinary(name: string, mode = 0o755): void {
  const p = join(dir, `${name}${EXE}`);
  writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, mode);
}

describe('checkBundledBinaries', () => {
  it('returns ok=true when all required binaries exist and are executable', () => {
    makeBinary('whisper-cli');
    makeBinary('ffmpeg');
    makeBinary('ffprobe');
    makeBinary('llama-server');
    const r = checkBundledBinaries(dir);
    expect(r.ok).toBe(true);
    expect(r.missing).toHaveLength(0);
    expect(r.statuses).toHaveLength(4);
  });

  it('flags individual binaries when missing from disk', () => {
    makeBinary('whisper-cli');
    makeBinary('llama-server');
    // ffmpeg + ffprobe absent
    const r = checkBundledBinaries(dir);
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.name).sort()).toEqual(['ffmpeg', 'ffprobe']);
    expect(r.missing.every((m) => !m.exists)).toBe(true);
  });

  it('returns all required missing when resources path is empty', () => {
    const r = checkBundledBinaries(dir);
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(4);
  });

  it.skipIf(IS_WIN)(
    'treats a non-executable file as missing on POSIX',
    () => {
      makeBinary('whisper-cli', 0o644); // -rw-r--r-- → not executable
      makeBinary('ffmpeg');
      makeBinary('ffprobe');
      makeBinary('llama-server');
      const r = checkBundledBinaries(dir);
      expect(r.ok).toBe(false);
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]?.name).toBe('whisper-cli');
      expect(r.missing[0]?.exists).toBe(true);
      expect(r.missing[0]?.executable).toBe(false);
    },
  );
});

describe('formatMissingForDialog', () => {
  it('produces one bullet per missing binary with reason and path', () => {
    const out = formatMissingForDialog([
      { name: 'ffmpeg', path: '/x/ffmpeg', exists: false, executable: false },
      { name: 'whisper-cli', path: '/x/wc', exists: true, executable: false },
    ]);
    expect(out).toContain('• ffmpeg (not found)');
    expect(out).toContain('/x/ffmpeg');
    expect(out).toContain('• whisper-cli (not executable)');
    expect(out).toContain('/x/wc');
  });

  it('returns empty string for an empty list', () => {
    expect(formatMissingForDialog([])).toBe('');
  });
});
