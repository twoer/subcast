/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLlmBySymlink, installLlmByCopy } from '../llmInstall';

describe('llmInstall', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llminstall-'));
    process.env.SUBCAST_HOME = dir;
    process.env.SUBCAST_DESKTOP = 'true';
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SUBCAST_HOME;
    delete process.env.SUBCAST_DESKTOP;
  });

  it('symlinks src to canonical install path', async () => {
    const src = join(dir, 'fake.gguf');
    await writeFile(src, 'X');
    const { destPath } = await installLlmBySymlink(src, '7b');
    const st = await lstat(destPath);
    expect(st.isSymbolicLink()).toBe(true);
  });

  it('copy makes a real file', async () => {
    const src = join(dir, 'fake.gguf');
    await writeFile(src, 'XYZ');
    const { destPath } = await installLlmByCopy(src, '3b');
    const content = await readFile(destPath, 'utf8');
    expect(content).toBe('XYZ');
  });
});
