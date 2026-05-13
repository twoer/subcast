/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Pre-flight check for sidecar binaries (whisper-cli, ffmpeg, ffprobe).
 *
 * The packaged app ships these via electron-builder's extraResources.
 * If one is missing (build pipeline glitch, partial copy on install,
 * antivirus quarantine, user manually editing the .app), every
 * transcription will fail at the spawn point with a confusing error
 * far from the cause. Catching it at bootstrap turns a silent runtime
 * failure into a clear actionable dialog.
 *
 * In dev mode (`app.isPackaged === false`) we run the same check but
 * only return its result — the caller decides whether to gate startup
 * or just log a warning. This matches the existing ffmpegPaths.ts
 * fallback that lets dev runs use the npm-installed ffmpeg.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';
const IS_WIN = process.platform === 'win32';

/** Set of binaries the packaged app cannot function without. */
const REQUIRED_BINARIES = ['whisper-cli', 'ffmpeg', 'ffprobe'] as const;
export type BinaryName = (typeof REQUIRED_BINARIES)[number];

export interface BinaryStatus {
  name: BinaryName;
  path: string;
  exists: boolean;
  executable: boolean;
}

export interface BinaryCheckResult {
  ok: boolean;
  resourcesPath: string;
  statuses: BinaryStatus[];
  missing: BinaryStatus[];
}

function isExecutable(path: string): boolean {
  if (IS_WIN) return true; // Windows treats .exe extension as executable
  try {
    const st = statSync(path);
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Walk the required-binary table against the given resources directory.
 * Pure: no logging, no dialog — caller decides what to do with the
 * result so this stays trivial to unit-test.
 */
export function checkBundledBinaries(resourcesPath: string): BinaryCheckResult {
  const statuses: BinaryStatus[] = REQUIRED_BINARIES.map((name) => {
    const path = join(resourcesPath, `${name}${EXE_SUFFIX}`);
    const exists = existsSync(path);
    const executable = exists && isExecutable(path);
    return { name, path, exists, executable };
  });
  const missing = statuses.filter((s) => !s.exists || !s.executable);
  return { ok: missing.length === 0, resourcesPath, statuses, missing };
}

/**
 * Format a missing-binaries list for the dialog `detail` field.
 * Bullet per binary, indicates the missing reason.
 */
export function formatMissingForDialog(missing: BinaryStatus[]): string {
  return missing
    .map((b) => {
      const reason = !b.exists ? 'not found' : 'not executable';
      return `• ${b.name} (${reason})\n    ${b.path}`;
    })
    .join('\n');
}
