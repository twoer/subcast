/* SPDX-License-Identifier: Apache-2.0 */
import { join } from 'node:path';

/**
 * Shared whisper.cpp filesystem layout.
 *
 * Two modes:
 *
 * 1. **Web / dev mode** (`SUBCAST_DESKTOP !== 'true'`):
 *    Paths derive from `process.cwd()`. Nitro bundles nodejs-whisper, so
 *    `__dirname` / `import.meta.url` inside the bundled server point at
 *    the bundle directory — using them to locate sibling binaries
 *    silently breaks. Resolving from cwd assumes the app is launched with
 *    the project root as cwd (true for `pnpm dev` / `pnpm preview`).
 *
 * 2. **Desktop mode** (`SUBCAST_DESKTOP === 'true'`):
 *    The Electron main process sets `SUBCAST_RESOURCES_PATH` (== Electron's
 *    `process.resourcesPath`) before importing Nitro. Binaries live there
 *    via electron-builder's `extraResources`. Models live under userData
 *    (see `SUBCAST_HOME`).
 */

const IS_DESKTOP = process.env.SUBCAST_DESKTOP === 'true';
const IS_WIN = process.platform === 'win32';
const EXE_SUFFIX = IS_WIN ? '.exe' : '';

function webModeNwRoot(): string {
  return join(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp');
}

function desktopResourcesPath(): string {
  const p = process.env.SUBCAST_RESOURCES_PATH;
  if (!p) {
    throw new Error(
      'SUBCAST_DESKTOP=true but SUBCAST_RESOURCES_PATH is unset — Electron main must set it before importing Nitro.',
    );
  }
  return p;
}

function desktopModelsDir(): string {
  const home = process.env.SUBCAST_HOME;
  if (!home) {
    throw new Error(
      'SUBCAST_DESKTOP=true but SUBCAST_HOME is unset — Electron main must set it from app.getPath("userData").',
    );
  }
  return join(home, 'models', 'whisper');
}

export const WHISPER_CLI_PATH = IS_DESKTOP
  ? join(desktopResourcesPath(), 'whisper-cli' + EXE_SUFFIX)
  : join(
      webModeNwRoot(),
      'build',
      'bin',
      ...(IS_WIN ? ['Release'] : []),
      'whisper-cli' + EXE_SUFFIX,
    );

export const WHISPER_MODELS_DIR = IS_DESKTOP
  ? desktopModelsDir()
  : join(webModeNwRoot(), 'models');

export function whisperModelPath(model: string): string {
  return join(WHISPER_MODELS_DIR, `ggml-${model}.bin`);
}
