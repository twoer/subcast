/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Seed the bundled SenseVoice model (model.int8.onnx + tokens.txt) into
 * userData on first launch, so a freshly installed Subcast can transcribe
 * with the default engine without any download. SenseVoice replaced the
 * old bundled ggml-base.bin — the app targets zh/en users first and
 * SenseVoice is the wizard default (see
 * docs/plans/2026-08-15-model-upgrade-qwen3-sensevoice.md).
 *
 * Strategy (idempotent, runs every startup):
 *
 *   1. If `<userData>/models/sensevoice/.bundled-sensevoice-dismissed`
 *      exists, the user explicitly deleted the bundled model — do not
 *      recreate it. (Delete handler writes this marker; see
 *      `server/api/desktop/sensevoice/model.delete.ts`.)
 *   2. If a file already exists at the destination (real file or
 *      symlink), leave that file alone — never overwrite a
 *      user-managed install.
 *   3. If the bundled source under `<resourcesPath>/models/sensevoice/`
 *      is missing (older build, dev environment), do nothing.
 *   4. Otherwise, `fs.symlink` source → dest per file. Zero extra disk;
 *      macOS atomic-replaces the .app on update so the symlink targets
 *      stay valid across versions.
 *
 * Sync `existsSync` checks instead of async stat: the work is only a
 * handful of lstat calls and we want it complete before Nitro imports,
 * since the sensevoice model dir is resolved lazily but readiness is
 * probed by the first /api/desktop/models call.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const DISMISSED_MARKER = '.bundled-sensevoice-dismissed';
const BUNDLED_FILES = ['model.int8.onnx', 'tokens.txt'] as const;

export interface SeedResult {
  /** 'seeded' = at least one symlink created; 'skipped' = no action; 'failed' = exception. */
  status: 'seeded' | 'skipped' | 'failed';
  reason: string;
  /** Destination directory (`<userData>/models/sensevoice`). */
  destDir: string;
  /** Bundled source directory (`<resourcesPath>/models/sensevoice`). */
  sourceDir: string;
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

export function seedBundledSenseVoice(
  resourcesPath: string,
  userDataPath: string,
): SeedResult {
  const sourceDir = join(resourcesPath, 'models', 'sensevoice');
  const destDir = join(userDataPath, 'models', 'sensevoice');
  const markerPath = join(destDir, DISMISSED_MARKER);

  if (pathExists(markerPath)) {
    return { status: 'skipped', reason: 'dismissed', destDir, sourceDir };
  }
  const missingSources = BUNDLED_FILES.filter((f) => !existsSync(join(sourceDir, f)));
  if (missingSources.length > 0) {
    return { status: 'skipped', reason: 'source-missing', destDir, sourceDir };
  }

  mkdirSync(destDir, { recursive: true });
  let seeded = 0;
  try {
    for (const file of BUNDLED_FILES) {
      const destPath = join(destDir, file);
      if (pathExists(destPath)) continue;
      symlinkSync(join(sourceDir, file), destPath);
      seeded++;
    }
  } catch (err) {
    if (seeded > 0) {
      return {
        status: 'failed',
        reason: `partial seed (${seeded}/${BUNDLED_FILES.length}): ${err instanceof Error ? err.message : String(err)}`,
        destDir,
        sourceDir,
      };
    }
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      destDir,
      sourceDir,
    };
  }
  return {
    status: seeded > 0 ? 'seeded' : 'skipped',
    reason: seeded > 0 ? 'symlinked' : 'dest-exists',
    destDir,
    sourceDir,
  };
}
