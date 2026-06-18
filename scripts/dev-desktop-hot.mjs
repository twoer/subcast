#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Hot-reload desktop dev orchestrator.
 *
 * Flow:
 *   1. Generate a session token; build the env both children must share
 *      (SUBCAST_DESKTOP=true, SUBCAST_API_TOKEN, SUBCAST_HOME pointing at
 *      a repo-local `.dev-userdata`, SUBCAST_RESOURCES_PATH at `resources/`,
 *      SUBCAST_DEV_URL telling Electron main to skip Nitro embedding).
 *   2. Compile electron main (one-shot tsc) — required because
 *      package.json's "main" field references the compiled `.js`.
 *   3. Spawn `nuxt dev` with that env so Nitro's API endpoints run in
 *      desktop mode (token-auth, /api/desktop/*, etc.) AND Vite hot-reloads
 *      every renderer save.
 *   4. Poll http://127.0.0.1:3000/api/health until it responds (or 401 —
 *      either way the server is up).
 *   5. Spawn `electron .` with the same env. Main checks SUBCAST_DEV_URL
 *      and `connectToDevServer()` instead of `startNitro()`.
 *   6. When Electron exits OR we receive SIGINT/SIGTERM, kill the nuxt
 *      child cleanly. Force-exit if it doesn't die in 2s.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// Electron binary path — same Node ABI used to launch electron itself.
// We use it to run `nuxt dev` (via ELECTRON_RUN_AS_NODE=1) so the dev
// server can load the same native modules (better-sqlite3) that we just
// rebuilt for Electron's ABI. Without this, electron-rebuild would
// silently break the dev server's native imports.
const require_ = createRequire(import.meta.url);
const electronPath = require_('electron');
const nuxtCliPath = join(repoRoot, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs');

const DEV_HOST = '127.0.0.1';
const DEV_PORT = 3000;
const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}`;
// Nuxt dev cold-start on slow machines easily exceeds 30s (Nitro build +
// Vite warmup + module init). Match the Electron-side waiter and leave
// headroom on top of that.
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

const userDataDir = join(repoRoot, '.dev-userdata');
await mkdir(userDataDir, { recursive: true });

// Locate whisper-cli + friends. The repo ships prebuilt binaries under
// `binaries/<platform>-<arch>/` (used by electron-builder extraResources).
// Pointing SUBCAST_RESOURCES_PATH at that dir lets desktop-mode whisper
// transcription work without copying anything. ffmpeg/ffprobe come from
// npm packages in web mode and are NOT in this dir — actually invoking
// transcription in hot mode will need them symlinked or installed
// separately. Renderer HMR (the primary goal) works regardless.
const resourcesDir = join(repoRoot, 'binaries', `${process.platform}-${process.arch}`);
if (!existsSync(resourcesDir)) {
  console.warn(
    `[hot] No prebuilt binaries dir at ${resourcesDir}. Whisper transcription ` +
    `will fail in hot mode until you create it. UI/HMR still works.`,
  );
}

// llama-server location for AI features. Packaged builds ship it under
// extraResources (same dir as whisper-cli), but in hot dev mode the
// developer may not have run `scripts/fetch-llama-server.mjs` yet — so
// we also probe a couple of common system locations as a fallback. The
// search order is: (1) repo-local CI artifact, (2) homebrew arm64,
// (3) homebrew x86_64 / /usr/local, (4) PATH.
const llamaExt = process.platform === 'win32' ? '.exe' : '';
const llamaServerCandidates = [
  join(resourcesDir, `llama-server${llamaExt}`),
  `/opt/homebrew/bin/llama-server${llamaExt}`,
  `/usr/local/bin/llama-server${llamaExt}`,
];
let llamaServerPath = '';
for (const c of llamaServerCandidates) {
  if (existsSync(c)) { llamaServerPath = c; break; }
}
if (!llamaServerPath) {
  console.warn(
    `[hot] llama-server not found in any of: ${llamaServerCandidates.join(', ')}.\n` +
    `       AI features (translation / insights) will throw \`binaryPath must be set\` ` +
    `until you either:\n` +
    `       (a) brew install llama.cpp  (macOS, easiest), or\n` +
    `       (b) build llama-server yourself and place it at ${llamaServerCandidates[0]}\n` +
    `       UI/HMR + Whisper transcription work regardless.`,
  );
} else {
  console.log(`[hot] llama-server resolved to ${llamaServerPath}`);
}

const env = {
  ...process.env,
  SUBCAST_DESKTOP: 'true',
  SUBCAST_API_TOKEN: randomUUID(),
  SUBCAST_HOME: userDataDir,
  SUBCAST_RESOURCES_PATH: resourcesDir,
  ...(llamaServerPath ? { SUBCAST_LLM_BINARY_PATH: llamaServerPath } : {}),
  SUBCAST_DEV_URL: DEV_URL,
  // Nuxt's default dev host is 0.0.0.0:3000 (see nuxt.config.ts). Pin
  // the host explicitly so a stray $HOST env doesn't repoint it.
  HOST: '0.0.0.0',
  PORT: String(DEV_PORT),
};

const children = [];

function spawnChild(cmd, args, label, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    stdio: 'inherit',
  });
  child.label = label;
  children.push(child);
  child.on('exit', (code, signal) => {
    console.log(`[hot] ${label} exited (code=${code}, signal=${signal ?? 'none'})`);
    shutdown(code ?? 0);
  });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  // Hard exit after grace period in case a child ignores SIGTERM.
  setTimeout(() => process.exit(code), 2_000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForHealth() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DEV_URL}/api/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (r.ok || r.status === 401) return true;
    } catch {
      /* not yet */
    }
    await sleep(READY_POLL_MS);
  }
  return false;
}

console.log('[hot] rebuilding native modules for Electron ABI (better-sqlite3)…');
console.log('[hot]   (fast on subsequent runs; runs `pnpm rebuild better-sqlite3` after web-mode dev to restore Node ABI)');
await new Promise((res, rej) => {
  // `electron-rebuild` (no -f) skips when the binary already matches
  // Electron's ABI, so steady-state is fast. The forceful version lives in
  // `pnpm build:desktop:native` for release builds.
  const reb = spawn('pnpm', ['exec', 'electron-rebuild', '-w', 'better-sqlite3'], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  reb.on('exit', (code) => (code === 0 ? res() : rej(new Error(`electron-rebuild exited ${code}`))));
});

console.log('[hot] compiling electron main…');
await new Promise((res, rej) => {
  const tsc = spawn('pnpm', ['build:desktop:main'], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  tsc.on('exit', (code) => (code === 0 ? res() : rej(new Error(`tsc exited ${code}`))));
});

console.log('[hot] launching nuxt dev under electron-as-node (matches better-sqlite3 ABI)…');
spawnChild(electronPath, [nuxtCliPath, 'dev'], 'nuxt', { ELECTRON_RUN_AS_NODE: '1' });

console.log(`[hot] waiting for ${DEV_URL}/api/health …`);
const ready = await waitForHealth();
if (!ready) {
  console.error(
    `[hot] dev server did not become ready within ${READY_TIMEOUT_MS}ms — ` +
    `if Nuxt is still warming up, bump READY_TIMEOUT_MS in scripts/dev-desktop-hot.mjs`,
  );
  shutdown(1);
} else {
  console.log('[hot] dev server ready — launching electron');
  spawnChild(electronPath, ['.'], 'electron');
}
