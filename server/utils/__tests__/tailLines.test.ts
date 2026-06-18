/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailLines } from '../tailLines';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tailLines-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('tailLines', () => {
  it('returns the last N lines in original order', async () => {
    const p = write('a.log', 'one\ntwo\nthree\nfour\nfive\n');
    expect(await tailLines(p, 3)).toEqual(['three', 'four', 'five']);
  });

  it('returns all lines when file has fewer than N', async () => {
    const p = write('b.log', 'one\ntwo\n');
    expect(await tailLines(p, 10)).toEqual(['one', 'two']);
  });

  it('handles file without trailing newline', async () => {
    const p = write('c.log', 'one\ntwo\nthree');
    expect(await tailLines(p, 2)).toEqual(['two', 'three']);
  });

  it('skips empty lines', async () => {
    const p = write('d.log', 'one\n\n\ntwo\n\nthree\n');
    expect(await tailLines(p, 5)).toEqual(['one', 'two', 'three']);
  });

  it('returns empty array for n=0', async () => {
    const p = write('e.log', 'one\ntwo\n');
    expect(await tailLines(p, 0)).toEqual([]);
  });

  it('returns empty array for empty file', async () => {
    const p = write('f.log', '');
    expect(await tailLines(p, 5)).toEqual([]);
  });

  it('memory is bounded — tail of a 10k-line file works at small N', async () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `line-${i}`);
    const p = write('big.log', lines.join('\n') + '\n');
    const out = await tailLines(p, 3);
    expect(out).toEqual(['line-9997', 'line-9998', 'line-9999']);
  });
});
