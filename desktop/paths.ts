/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared filesystem-path resolvers for the Electron main process.
 *
 * Pulled out of `main.ts` and `nitroEmbed.ts` so both code paths agree
 * on where the sidecar binaries (ffmpeg / ffprobe / whisper-cli) live.
 * Previously each file inlined the same `env || resourcesPath || repo
 * fallback` chain and drifted independently — a real risk because the
 * packaged binary check (main.ts) and the in-process Nitro embed
 * (nitroEmbed.ts) MUST point at the same directory.
 */

import { app } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the directory that ships `whisper-cli`, `ffmpeg`, and
 * `ffprobe`. Three precedence tiers:
 *
 *   1. `SUBCAST_RESOURCES_PATH` env var — set by the hot-reload dev
 *      orchestrator (scripts/dev-desktop-hot.mjs) before launching
 *      Electron, so the script can point at repo-local `resources/`
 *      or `binaries/<plat>-<arch>/`.
 *   2. Electron's `process.resourcesPath` — the canonical location
 *      after electron-builder packs into the .app / installer.
 *   3. Repo-local `resources/` next to the compiled `desktop-dist/`
 *      — the unpacked dev path for `pnpm dev:desktop`.
 */
export function resolveResourcesPath(): string {
  const fromEnv = process.env.SUBCAST_RESOURCES_PATH;
  if (fromEnv) return fromEnv;
  if (app.isPackaged) return process.resourcesPath;
  // dev fallback: <repo>/resources/, computed relative to the caller.
  // Use this file's location as the anchor — it ships in desktop-dist/
  // alongside main.js and nitroEmbed.js, so `..` lands at the repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'resources');
}
