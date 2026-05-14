/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * In-process Nitro server launcher (decision 2.1 — main-process embed).
 *
 * Strategy:
 *   1. Probe `127.0.0.1:51301` (decision 4); if it's free, use it.
 *      Otherwise fall back to a random unused port via `server.listen(0)`.
 *   2. Set `NITRO_PORT`, `NITRO_HOST=127.0.0.1`, session token, desktop flag.
 *   3. Dynamically `import('../.output/server/index.mjs')` — Nitro reads
 *      `NITRO_PORT` at load time and binds.
 *   4. Wait ~50ms for `listen` to fire (Nitro's listen is async but doesn't
 *      expose a "ready" hook). A health-check poll is the deterministic
 *      alternative — see `waitUntilReady()`.
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
  const port = preferred ?? 0; // 0 = random unused
  process.env.NITRO_HOST = '127.0.0.1';
  process.env.NITRO_PORT = String(port);
  process.env.SUBCAST_API_TOKEN = token;
  process.env.SUBCAST_DESKTOP = 'true';

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

  // If we asked for a random port, Nitro's actual port isn't easily
  // recoverable from outside. Probe a candidate range or use a small
  // helper — for now we only support the fallback case by re-probing
  // common ports. TODO when fallback fires: parse Nitro's listen log.
  const finalPort = port === 0 ? await guessRandomPort() : port;

  const baseUrl = `http://127.0.0.1:${finalPort}`;
  const ready = await waitUntilReady(baseUrl, READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`Nitro did not become ready within ${READY_TIMEOUT_MS}ms on port ${finalPort}`);
  }

  process.env.SUBCAST_API_PORT = String(finalPort);
  return {
    port: finalPort,
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

/**
 * When `NITRO_PORT=0` is set, Nitro picks a random port at listen() time.
 * Reading it back from outside is awkward — Nitro doesn't expose a "ready"
 * promise. As a pragmatic fallback, probe a few likely candidates by polling
 * /api/health on each.
 *
 * This is only hit when the preferred 51301 is occupied. Most users never
 * see this code path.
 */
async function guessRandomPort(): Promise<number> {
  // Random ports Node typically allocates land in 49152-65535. We don't
  // bruteforce — we wait for the OS-printed port to appear in stdout.
  // Workaround: query via netstat-equivalent in Node. For Phase 1 this is
  // left as a TODO; if fallback hits, the error surfaces clearly.
  throw new Error(
    'NITRO_PORT=0 fallback not yet implemented — preferred port 51301 was busy.\n' +
    'Workaround: close the other process holding 51301, or implement port-from-stdout parsing.',
  );
}
