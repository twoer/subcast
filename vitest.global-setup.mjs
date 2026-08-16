/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Runs once in the vitest main process before test workers spawn.
 *
 * Server-side tests import better-sqlite3, whose native binary flips
 * between the system-Node ABI and Electron's ABI depending on which
 * context (web dev / desktop dev / packaging / pnpm install) touched
 * it last. Loading the wrong ABI fails every sqlite-touching test with
 * a cryptic ERR_DLOPEN_FAILED.
 *
 * ensure-sqlite-abi.mjs is idempotent and fast when already correct
 * (<200ms), so unconditionally aligning it here guards EVERY vitest
 * entry point — `pnpm test`, `pnpm vitest --run <file>` (which bypasses
 * the pretest hook), test:watch — not just the scripted ones.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export default function ensureSqliteAbiForVitest() {
  const here = dirname(fileURLToPath(import.meta.url));
  const res = spawnSync(
    process.execPath,
    [join(here, 'scripts', 'ensure-sqlite-abi.mjs'), 'node'],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    throw new Error(
      '[vitest global-setup] ensure-sqlite-abi failed — see output above. ' +
      'Manual fix: pnpm rebuild better-sqlite3',
    );
  }
}
