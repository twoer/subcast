/* SPDX-License-Identifier: Apache-2.0 */

import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_META, scanWhisperModels } from '../whisperScan';

async function fakeModel(dir: string, name: string, sizeBytes: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const handle = await open(join(dir, name), 'w');
  try {
    await handle.truncate(sizeBytes);
  } finally {
    await handle.close();
  }
}

describe('scanWhisperModels', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'subcast-scan-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('finds a base model with a plausible size', async () => {
    const root = join(tmp, 'models');
    await fakeModel(root, 'ggml-base.bin', MODEL_META.base.minBytes + 1024);

    const results = await scanWhisperModels({ rootPaths: [root] });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('base');
    expect(results[0]!.source).toBe(root);
    expect(results[0]!.verified).toBe(null);
  });

  it('rejects files smaller than the size floor (likely truncated)', async () => {
    const root = join(tmp, 'models');
    await fakeModel(root, 'ggml-medium.bin', 50 * 1024 * 1024);

    const results = await scanWhisperModels({ rootPaths: [root] });
    expect(results).toHaveLength(0);
  });

  it('ignores unrelated files', async () => {
    const root = join(tmp, 'models');
    await fakeModel(root, 'README.md', 1024);
    await fakeModel(root, 'random.bin', 100 * 1024 * 1024);
    await fakeModel(root, 'ggml-tinyish.bin', 100 * 1024 * 1024);

    const results = await scanWhisperModels({ rootPaths: [root] });
    expect(results).toHaveLength(0);
  });

  it('merges extraPaths and labels them as User', async () => {
    const root = join(tmp, 'roots');
    const extra = join(tmp, 'extra');
    await fakeModel(root, 'ggml-tiny.bin', MODEL_META.tiny.minBytes + 1);
    await fakeModel(extra, 'ggml-small.bin', MODEL_META.small.minBytes + 1);

    const results = await scanWhisperModels({
      rootPaths: [root],
      extraPaths: [extra],
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.name === 'small')!.source).toBe('User');
    expect(results.find((r) => r.name === 'tiny')!.source).toBe(root);
  });

  it('deduplicates when extraPaths and rootPaths overlap', async () => {
    const root = join(tmp, 'shared');
    await fakeModel(root, 'ggml-tiny.bin', MODEL_META.tiny.minBytes + 1);

    const results = await scanWhisperModels({
      rootPaths: [root],
      extraPaths: [root],
    });

    expect(results).toHaveLength(1);
  });

  it('returns empty for non-existent roots without throwing', async () => {
    const missing = join(tmp, 'does-not-exist');
    const results = await scanWhisperModels({ rootPaths: [missing] });
    expect(results).toEqual([]);
  });
});
