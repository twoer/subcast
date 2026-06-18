#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-platform replacement for:
 *   mv -f desktop-dist/preload.js desktop-dist/preload.cjs
 *   mv -f desktop-dist/preload.js.map desktop-dist/preload.cjs.map 2>/dev/null || true
 *
 * `mv` doesn't exist on Windows; the package.json inline form failed under
 * cmd.exe. This renames the two preload outputs that tsc emits (.js → .cjs)
 * so Electron can load them, ignoring "file not found" (tsc may not emit a
 * map, or preload may be skipped on some builds).
 */
import { renameSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'desktop-dist';
const pairs = [
  ['preload.js', 'preload.cjs'],
  ['preload.js.map', 'preload.cjs.map'],
];

for (const [from, to] of pairs) {
  try {
    renameSync(join(dir, from), join(dir, to));
    console.log(`[rename-preload] ${dir}/${from} -> ${dir}/${to}`);
  } catch (err) {
    if (err?.code === 'ENOENT') continue; // not emitted this build — fine
    console.warn(`[rename-preload] could not rename ${from}: ${err.message}`);
  }
}
