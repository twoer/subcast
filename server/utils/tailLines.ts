/* SPDX-License-Identifier: Apache-2.0 */

import { createReadStream } from 'node:fs';

/**
 * Stream-tail a text file: return the last `n` non-empty lines without
 * loading the whole file into memory. Used by the in-app log viewer so
 * a multi-GB log file doesn't blow up the server when the user picks a
 * large tail.
 *
 * Implementation: read forward, keep a ring buffer of size `n`, replay
 * in order at the end. Memory is O(n × avg-line-length), independent of
 * file size.
 */
export async function tailLines(path: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const ring: string[] = new Array(n);
  let count = 0;
  let leftover = '';
  for await (const chunk of stream) {
    leftover += chunk as string;
    let nl = leftover.indexOf('\n');
    while (nl !== -1) {
      const line = leftover.slice(0, nl);
      leftover = leftover.slice(nl + 1);
      if (line.length > 0) {
        ring[count % n] = line;
        count++;
      }
      nl = leftover.indexOf('\n');
    }
  }
  if (leftover.length > 0) {
    ring[count % n] = leftover;
    count++;
  }
  if (count <= n) return ring.slice(0, count);
  const out: string[] = [];
  const start = count % n;
  for (let i = 0; i < n; i++) {
    const slot = (start + i) % n;
    const v = ring[slot];
    if (typeof v === 'string') out.push(v);
  }
  return out;
}
