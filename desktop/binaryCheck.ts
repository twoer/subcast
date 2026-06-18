/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Pre-flight check for sidecar binaries (whisper-cli, ffmpeg, ffprobe, llama-server).
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

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';
const IS_WIN = process.platform === 'win32';

/** Set of binaries the packaged app cannot function without. */
const REQUIRED_BINARIES = ['whisper-cli', 'ffmpeg', 'ffprobe', 'llama-server'] as const;
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
 * Strip `com.apple.quarantine` from every file under `resourcesPath` so
 * the bundled sidecar binaries aren't killed by amfid on first launch.
 *
 * Apple Silicon enforces a valid signature on every executable. Our
 * `extraResources` binaries are ad-hoc signed (`identity: null`), which
 * amfid normally tolerates — but if the user downloaded the dmg via a
 * browser, macOS sets `com.apple.quarantine` on every file inside the
 * bundle. The OS strips it from `Subcast.app` itself on first "Open
 * Anyway", but the recursion doesn't always reach `Contents/Resources`
 * children. The orphan quarantine attribute then makes Gatekeeper kill
 * `whisper-cli` / `llama-server` etc. with SIGABRT in 1-7 ms — the
 * caller sees an opaque crash with no stderr.
 *
 * Idempotent + best-effort: `xattr -dr` silently skips files without
 * the attribute and returns 0. Outcome is logged to console (Electron
 * main has no structured logger pre-Nitro; matches existing
 * orphanCleanup / binaryCheck conventions) so a future diagnostic
 * `subcast.app/Contents/MacOS/Subcast` run from terminal reveals
 * whether the strip actually ran.
 */
export function stripQuarantine(resourcesPath: string): void {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', resourcesPath], {
      stdio: 'ignore',
      timeout: 5000,
    });
    console.log(`[subcast] stripped com.apple.quarantine from ${resourcesPath}`);
  } catch (err) {
    console.warn(
      `[subcast] strip quarantine failed (${resourcesPath}):`,
      err instanceof Error ? err.message : err,
    );
  }
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
