/* SPDX-License-Identifier: Apache-2.0 */

/**
 * In-process Nitro server launcher (decision 2.1 — main-process embed).
 *
 * Strategy:
 *   1. Probe `127.0.0.1:51301` (decision 4); if it's free, use it.
 *      Otherwise ask the OS for an unused port before importing Nitro.
 *   2. Set `NITRO_PORT`, `NITRO_HOST=127.0.0.1`, session token, desktop flag.
 *   3. Dynamically `import('../.output/server/index.mjs')` — Nitro reads
 *      `NITRO_PORT` at load time and binds.
 *   4. Poll /api/health until the server is responsive.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import process from 'node:process';
import { app } from 'electron';
import { resolveResourcesPath } from './paths.js';

const PREFERRED_PORT = 51301;
// 10s is plenty for the embedded Nitro path (in-process import); the
// HMR dev path has to wait for an externally-running Nuxt dev server,
// which can stall mid-startup while Vite warms the client bundle.
const READY_TIMEOUT_MS = 10_000;
const DEV_READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 100;

export interface NitroHandle {
  port: number;
  token: string;
  url: string;
}

/**
 * Test whether a port can be bound on 127.0.0.1. Resolves to the same port
 * if free, or null if occupied.
 */
function probePort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(null));
    tester.once('listening', () => {
      tester.close(() => resolve(port));
    });
    tester.listen({ port, host: '127.0.0.1' });
  });
}

/**
 * Ask the OS for an unused loopback port, close the probe server, and return
 * the selected number. There is always a small release/rebind race, but this
 * is the same shape as probing the preferred port and avoids Nitro's
 * NITRO_PORT=0 path where the actual port is not observable from here.
 */
function reserveRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', reject);
    tester.once('listening', () => {
      const address = tester.address();
      tester.close(() => {
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error('failed to reserve a random loopback port'));
        }
      });
    });
    tester.listen({ port: 0, host: '127.0.0.1' });
  });
}

/**
 * Poll GET <baseUrl>/api/health until 200 or timeout. Returns true if
 * Nitro is responsive.
 */
async function waitUntilReady(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (res.ok || res.status === 401) return true; // 401 still means Nitro is up
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  console.error(`[subcast] waitUntilReady(${baseUrl}) timed out — last error: ${lastErr}`);
  return false;
}

export async function startNitro(): Promise<NitroHandle> {
  const token = randomUUID();

  // Decide port BEFORE importing Nitro — Nitro reads NITRO_PORT at module load.
  const preferred = await probePort(PREFERRED_PORT);
  const port = preferred ?? await reserveRandomPort();
  process.env.NITRO_HOST = '127.0.0.1';
  process.env.NITRO_PORT = String(port);
  process.env.SUBCAST_API_TOKEN = token;
  process.env.SUBCAST_DESKTOP = 'true';
  // App version flows into the diagnostic export filename so support
  // tickets can match an uploaded zip back to the release that produced
  // it. Read by server/api/diagnostic.get.ts.
  process.env.SUBCAST_APP_VERSION = app.getVersion();

  // Desktop home directory (decision 1.3 — userData under OS conventions).
  process.env.SUBCAST_HOME = app.getPath('userData');
  // Resources path — electron-builder extraResources (ffmpeg, whisper-cli,
  // ggml model binaries) land here. Shared resolver so the binary check
  // in main.ts and the Nitro embed agree on the location.
  process.env.SUBCAST_RESOURCES_PATH = resolveResourcesPath();
  // llama-server binary path — read by `server/utils/llmServer.ts` (which
  // can't `import { app }` from electron). The Nitro-side LlmServer lazy-
  // singleton reads this at first ensure() to spawn the sidecar.
  process.env.SUBCAST_LLM_BINARY_PATH = join(
    resolveResourcesPath(),
    'llama-server' + (process.platform === 'win32' ? '.exe' : ''),
  );

  // Locate .output/server/index.mjs relative to the compiled main.js.
  // In dev: desktop-dist/main.js → ../.output/server/index.mjs (from repo root).
  // In packaged: electron-builder ships .output/** into the asar, so the
  // same relative resolution lands inside `app.asar/.output/server/`.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..');
  const nitroEntry = join(repoRoot, '.output', 'server', 'index.mjs');

  if (!existsSync(nitroEntry)) {
    // A bare `await import()` of a missing file rejects with the cryptic
    // ERR_MODULE_NOT_FOUND. Surface an actionable message instead so the
    // startup dialog tells the user what to do next.
    const hint = app.isPackaged
      ? 'Reinstall Subcast from the official release page.'
      : 'Run `pnpm build` to produce .output/, or use `pnpm dev:desktop:hot` for hot-reload dev.';
    throw new Error(
      `Nitro server bundle missing at ${nitroEntry}. ${hint}`,
    );
  }

  console.log('[subcast] importing Nitro from', nitroEntry);
  await import(pathToFileURL(nitroEntry).href);

  const baseUrl = `http://127.0.0.1:${port}`;
  const ready = await waitUntilReady(baseUrl, READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`Nitro did not become ready within ${READY_TIMEOUT_MS}ms on port ${port}`);
  }

  process.env.SUBCAST_API_PORT = String(port);
  return {
    port,
    token,
    url: baseUrl,
  };
}

/**
 * HMR-mode counterpart of `startNitro`: skips embedding and just probes an
 * externally-running Nuxt dev server (started by the orchestrator script
 * with the same `SUBCAST_API_TOKEN`/`SUBCAST_DESKTOP`/`SUBCAST_HOME`
 * environment so its API surface matches a packaged desktop run).
 *
 * Designed for `scripts/dev-desktop-hot.mjs` workflow: edit Vue, save,
 * Vite hot-reloads in the Electron window without rebuilding the SPA.
 */
export async function connectToDevServer(devUrl: string): Promise<NitroHandle> {
  const u = new URL(devUrl);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const token = process.env.SUBCAST_API_TOKEN;
  if (!token) {
    throw new Error(
      'SUBCAST_DEV_URL is set but SUBCAST_API_TOKEN is missing — both must be set by the dev-desktop-hot orchestrator.',
    );
  }
  const baseUrl = devUrl.replace(/\/$/, '');

  const ready = await waitUntilReady(baseUrl, DEV_READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`Dev server at ${baseUrl} did not respond within ${DEV_READY_TIMEOUT_MS}ms`);
  }

  process.env.SUBCAST_API_PORT = String(port);
  return { port, token, url: baseUrl };
}
