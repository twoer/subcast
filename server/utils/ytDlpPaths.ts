/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the absolute path to the yt-dlp sidecar binary.
 *
 * Three precedence tiers, matching ffmpegPaths.ts:
 *
 * 1. **Desktop + packaged**: binary bundled via electron-builder
 *    `extraResources` at `SUBCAST_RESOURCES_PATH/yt-dlp`.
 * 2. **Desktop + dev** (`SUBCAST_DESKTOP=true` but not packaged —
 *    `pnpm dev:desktop`): `SUBCAST_RESOURCES_PATH` points at
 *    `<repo>/resources/`, which does NOT contain yt-dlp. Fall back to
 *    the repo-local fetch at `binaries/<plat>-<arch>/yt-dlp` (what
 *    scripts/fetch-yt-dlp.mjs stages). This mirrors how ffmpegPaths
 *    falls back to its npm-installed binary in dev.
 * 3. **Web / pure-dev** (`SUBCAST_DESKTOP !== 'true'`): same repo-local
 *    `binaries/` lookup, then bare `'yt-dlp'` PATH lookup so a brew/pip
 *    install also works.
 *
 * Web mode resolves relative to `process.cwd()` for the same reason
 * whisperPaths.ts does: inside the bundled Nitro server,
 * `import.meta.url` points at the bundle dir, not the repo root.
 */

const IS_DESKTOP = process.env.SUBCAST_DESKTOP === 'true';
const IS_WIN = process.platform === 'win32';
const EXE_SUFFIX = IS_WIN ? '.exe' : '';

function platArch(): string {
  const platform = IS_WIN ? 'win32' : process.platform;
  return `${platform}-${process.arch}`;
}

/** Repo-local fetch destination (scripts/fetch-yt-dlp.mjs output). */
function repoLocalBinary(): string {
  return join(process.cwd(), 'binaries', platArch(), `yt-dlp${EXE_SUFFIX}`);
}

/** Bare name for PATH lookup as a last resort (brew/pip yt-dlp). */
function pathBinary(): string {
  return `yt-dlp${EXE_SUFFIX}`;
}

export const YT_DLP_PATH: string = (() => {
  // Tier 1 + 2: desktop mode (packaged or dev).
  if (IS_DESKTOP) {
    const root = process.env.SUBCAST_RESOURCES_PATH;
    if (root) {
      const packaged = join(root, `yt-dlp${EXE_SUFFIX}`);
      if (existsSync(packaged)) return packaged;
    }
    // Dev:desktop falls through here — SUBCAST_RESOURCES_PATH=<repo>/resources/
    // has no yt-dlp. Fall back to the repo-local fetch, then PATH.
    const local = repoLocalBinary();
    if (existsSync(local)) return local;
    return pathBinary();
  }
  // Tier 3: web / pure-dev.
  const local = repoLocalBinary();
  return existsSync(local) ? local : pathBinary();
})();
