/* SPDX-License-Identifier: Apache-2.0 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLM_MODELS } from '../llmConfig';
import { scanLlmModels } from '../llmScan';

describe('scanLlmModels', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llmscan-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a Qwen2.5-7B file when override floor is in effect', async () => {
    // The real catalog ±30% check wants a multi-GB fixture, which is too slow
    // to materialize per-test. minSizeOverride: 0 is the test seam that swaps
    // both the floor AND the catalog-based size sanity off so we can use
    // tiny placeholder files.
    const subdir = join(dir, 'qwen-models');
    await mkdir(subdir, { recursive: true });
    const path = join(subdir, 'Qwen2.5-7B-Instruct-Q4_K_M.gguf');
    await writeFile(path, 'x');
    const results = await scanLlmModels({ rootPaths: [subdir], minSizeOverride: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('7b');
  });

  it('walks 4 levels deep so LM Studio-style nested layouts are found', async () => {
    // Real LM Studio path:
    //   ~/.cache/lm-studio/models/lmstudio-community/Qwen2.5-7B-Instruct-GGUF/<file>
    // So scanning from the parent of `lmstudio-community` requires 4 levels.
    const nested = join(dir, 'lm-studio', 'models', 'lmstudio-community', 'Qwen2.5-7B-Instruct-GGUF');
    await mkdir(nested, { recursive: true });
    const path = join(nested, 'Qwen2.5-7B-Instruct-Q4_K_M.gguf');
    await writeFile(path, 'x');
    const results = await scanLlmModels({ rootPaths: [dir], minSizeOverride: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('7b');
    expect(results[0]!.path).toBe(path);
  });

  it('ignores files that do not match the Qwen2.5-Instruct-Q4_K_M GGUF pattern', async () => {
    const subdir = join(dir, 'q');
    await mkdir(subdir, { recursive: true });
    await writeFile(join(subdir, 'README.md'), 'x');
    // wrong base version (Qwen 2 vs Qwen 2.5)
    await writeFile(join(subdir, 'qwen2-7b-instruct-q4_k_m.gguf'), 'x');
    // unsupported parameter count
    await writeFile(join(subdir, 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), 'x');
    // wrong quant
    await writeFile(join(subdir, 'Qwen2.5-7B-Instruct-Q5_K_M.gguf'), 'x');
    const results = await scanLlmModels({ rootPaths: [subdir], minSizeOverride: 0 });
    expect(results).toHaveLength(0);
  });

  it('matches the filename case-insensitively', async () => {
    const subdir = join(dir, 'q');
    await mkdir(subdir, { recursive: true });
    // LM Studio sometimes uses lowercased filenames in its cache.
    const path = join(subdir, 'qwen2.5-3b-instruct-q4_k_m.gguf');
    await writeFile(path, 'x');
    const results = await scanLlmModels({ rootPaths: [subdir], minSizeOverride: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('3b');
  });

  it('merges extraPaths and labels them as User', async () => {
    const root = join(dir, 'r');
    const extra = join(dir, 'e');
    await mkdir(root, { recursive: true });
    await mkdir(extra, { recursive: true });
    await writeFile(join(root, 'Qwen2.5-3B-Instruct-Q4_K_M.gguf'), 'x');
    await writeFile(join(extra, 'Qwen2.5-14B-Instruct-Q4_K_M.gguf'), 'x');

    const results = await scanLlmModels({
      rootPaths: [root],
      extraPaths: [extra],
      minSizeOverride: 0,
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.name === '14b')!.source).toBe('User');
    expect(results.find((r) => r.name === '3b')!.source).toBe(root);
  });

  it('deduplicates when extraPaths overlap rootPaths', async () => {
    const root = join(dir, 'shared');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'), 'x');

    const results = await scanLlmModels({
      rootPaths: [root],
      extraPaths: [root],
      minSizeOverride: 0,
    });

    expect(results).toHaveLength(1);
  });

  it('returns empty for non-existent roots without throwing', async () => {
    const missing = join(dir, 'does-not-exist');
    const results = await scanLlmModels({ rootPaths: [missing], minSizeOverride: 0 });
    expect(results).toEqual([]);
  });

  it('rejects files smaller than the ±30% window when catalog size check is on', async () => {
    // No minSizeOverride → use catalog-based ±30% window. The file is well
    // below the 3B model's lower bound (sizeBytes * 0.7), so it must be dropped.
    const subdir = join(dir, 'truncated');
    await mkdir(subdir, { recursive: true });
    await writeFile(join(subdir, 'Qwen2.5-3B-Instruct-Q4_K_M.gguf'), 'x');
    const results = await scanLlmModels({ rootPaths: [subdir] });
    expect(results).toHaveLength(0);
    // Sanity check: a real 3B GGUF size meets the catalog floor.
    expect(LLM_MODELS['3b'].sizeBytes * 0.7).toBeGreaterThan(100);
  });
});
