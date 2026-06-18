/* SPDX-License-Identifier: Apache-2.0 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLlmBySymlink, installLlmByCopy, downloadLlmFromCandidates } from '../llmInstall';
import { LLM_MODELS } from '../llmConfig';

function fakeGguf(size: number): Buffer {
  const buf = Buffer.alloc(size, 1);
  buf.write('GGUF', 0, 'ascii');
  return buf;
}

describe('llmInstall', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llminstall-'));
    process.env.SUBCAST_HOME = dir;
    process.env.SUBCAST_DESKTOP = 'true';
  });
  afterEach(async () => {
    LLM_MODELS['3b'].sizeBytes = 1_930_000_000;
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

  it('falls back to the other auto mirror when the preferred source fails', async () => {
    LLM_MODELS['3b'].sizeBytes = 16;
    const urls: string[] = [];
    const destPath = join(dir, 'models', 'llm', LLM_MODELS['3b'].filename);
    await downloadLlmFromCandidates({
      urls: ['https://example.invalid/primary.gguf', 'https://example.invalid/backup.gguf'],
      destPath,
      validate: async () => {
        const content = await readFile(destPath, { encoding: null });
        if (content.subarray(0, 4).toString('ascii') !== 'GGUF') {
          throw new Error('invalid GGUF');
        }
      },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlText = String(url);
        const range = (init?.headers as Record<string, string> | undefined)?.Range;
        urls.push(urlText);
        if (urls.length === 1) {
          return new Response('not found', { status: 404, statusText: 'Not Found' });
        }

        const offset = range ? Number(/^bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
        return new Response(fakeGguf(16).slice(offset), {
          status: range ? 206 : 200,
          statusText: range ? 'Partial Content' : 'OK',
          headers: { 'content-length': String(16 - offset) },
        });
      }) as typeof globalThis.fetch,
    });

    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    const content = await readFile(destPath, { encoding: null });
    expect(content.subarray(0, 4).toString('ascii')).toBe('GGUF');
  });
});
