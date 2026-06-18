/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Resolve the absolute path to ffmpeg / ffprobe binaries.
 *
 * Two modes:
 *
 * 1. **Desktop mode** (`SUBCAST_DESKTOP=true`):
 *    Binaries are bundled via electron-builder `extraResources` and live
 *    under `process.resourcesPath` (read from `SUBCAST_RESOURCES_PATH`
 *    which Electron main injects).
 *
 * 2. **Web / dev mode**:
 *    Use `ffmpeg-static` (LGPL build) and `@ffprobe-installer/ffprobe` —
 *    no need to ask the user to install ffmpeg system-wide. Falls back
 *    to plain `'ffmpeg'` / `'ffprobe'` from PATH if the packages aren't
 *    installed (e.g., when whisper-cli is the only thing being tested).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const IS_DESKTOP = process.env.SUBCAST_DESKTOP === 'true';
const EXE = process.platform === 'win32' ? '.exe' : '';

function desktopBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const root = process.env.SUBCAST_RESOURCES_PATH;
  if (!root) {
    throw new Error(
      'SUBCAST_DESKTOP=true but SUBCAST_RESOURCES_PATH is unset — Electron main must set it before importing Nitro.',
    );
  }
  return join(root, name + EXE);
}

function webBinary(name: 'ffmpeg' | 'ffprobe'): string {
  try {
    if (name === 'ffmpeg') {
      // @ffmpeg-installer/ffmpeg ships a properly-signed arm64 binary
      // (unlike ffmpeg-static, whose binary has a malformed signature
      // that macOS amfid kills on child-spawn from an ad-hoc-signed
      // Electron app). Returns `{ path }` like the ffprobe sibling pkg.
      const { path } = require_('@ffmpeg-installer/ffmpeg') as { path: string };
      if (path) return path;
    } else {
      const { path } = require_('@ffprobe-installer/ffprobe') as { path: string };
      if (path) return path;
    }
  } catch {
    // packages not installed — fall back to PATH lookup
  }
  return name;
}

/**
 * In desktop mode the canonical location is electron-builder's
 * `extraResources` dir. For `dev:desktop:hot` the orchestrator points
 * `SUBCAST_RESOURCES_PATH` at `binaries/<plat>-<arch>` which only ships
 * whisper-cli — ffmpeg/ffprobe are not there. Fall back to the
 * npm-installed binary so transcription works without manual symlinks.
 */
function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  if (!IS_DESKTOP) return webBinary(name);
  const desktopPath = desktopBinary(name);
  return existsSync(desktopPath) ? desktopPath : webBinary(name);
}

export const FFMPEG_PATH = resolveBinary('ffmpeg');
export const FFPROBE_PATH = resolveBinary('ffprobe');
