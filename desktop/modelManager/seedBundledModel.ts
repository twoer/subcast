/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Seed the bundled `ggml-base.bin` Whisper model into userData on first
 * launch, so a freshly installed Subcast can transcribe without going
 * through the download flow in the setup wizard.
 *
 * Strategy (idempotent, runs every startup):
 *
 *   1. If `<userData>/models/whisper/ggml-base.bin` already exists
 *      (real file or symlink), do nothing.
 *   2. If `<userData>/models/whisper/.bundled-base-dismissed` exists,
 *      the user explicitly deleted the bundled model — do not recreate
 *      it. (Delete handler writes this marker; see
 *      `server/api/desktop/whisper/[model].delete.ts`.)
 *   3. If the bundled source at `<resourcesPath>/models/ggml-base.bin`
 *      is missing (older build, dev environment), do nothing.
 *   4. Otherwise, `fs.symlink` source → dest. Zero extra disk; macOS
 *      atomic-replaces the .app on update so the symlink target stays
 *      valid across versions.
 *
 * Sync `existsSync` checks instead of async stat: the work is only a
 * handful of lstat calls and we want it complete before Nitro imports,
 * since `WHISPER_MODELS_DIR` is read at module-load time inside Nitro.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DISMISSED_MARKER = '.bundled-base-dismissed';

export interface SeedResult {
  /** 'seeded' = symlink created; 'skipped' = no action; 'failed' = exception. */
  status: 'seeded' | 'skipped' | 'failed';
  reason: string;
  destPath: string;
  sourcePath: string;
}

/**
 * `lstatSync` so a dangling symlink still counts as "present" — we
 * don't want to overwrite a user-installed symlink the user manages.
 */
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function seedBundledBaseModel(
  resourcesPath: string,
  userDataPath: string,
): SeedResult {
  const sourcePath = join(resourcesPath, 'models', 'ggml-base.bin');
  const destDir = join(userDataPath, 'models', 'whisper');
  const destPath = join(destDir, 'ggml-base.bin');
  const markerPath = join(destDir, DISMISSED_MARKER);

  if (pathExists(destPath)) {
    return { status: 'skipped', reason: 'dest-exists', destPath, sourcePath };
  }
  if (pathExists(markerPath)) {
    return { status: 'skipped', reason: 'dismissed', destPath, sourcePath };
  }
  if (!existsSync(sourcePath)) {
    return { status: 'skipped', reason: 'source-missing', destPath, sourcePath };
  }

  try {
    mkdirSync(dirname(destPath), { recursive: true });
    symlinkSync(sourcePath, destPath);
    return { status: 'seeded', reason: 'symlinked', destPath, sourcePath };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      destPath,
      sourcePath,
    };
  }
}
