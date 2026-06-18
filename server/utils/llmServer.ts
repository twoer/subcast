/* SPDX-License-Identifier: Apache-2.0 */

import { spawn, type ChildProcess } from 'node:child_process';
import { llmModelPath } from '../../desktop/modelManager/llmInstall';
import { loadSettings } from './settings';

export type LlmServerState = 'idle' | 'starting' | 'running' | 'stopping';

export interface SpawnResult {
  proc: ChildProcess;
  port: number;
}

export interface LlmServerOptions {
  binaryPath?: string;
  modelPath?: string;
  preferredPort?: number;
  idleShutdownMs?: number;
  /** Test seam — defaults to real spawn-and-wait-for-port. */
  spawnFn?: () => Promise<SpawnResult>;
}

/**
 * Lifecycle owner for the llama-server sidecar. Single instance per
 * Nitro process. `ensure()` is the only method consumers call — it
 * resolves once a server is ready to receive requests, spawning if
 * needed and resetting the idle-shutdown timer on every call.
 *
 * State machine:
 *
 *   idle ──ensure()──▶ starting ──spawn resolves──▶ running
 *                          │                            │
 *                          │                            │ idle timer fires
 *                          │                            ▼
 *                          │                        stopping
 *                          │                            │
 *                          │                            │ proc exits
 *                          │                            ▼
 *                          └──────── (ensure() during stopping
 *                                     re-enters starting once stop completes) ──▶ idle
 */
export class LlmServer {
  private _state: LlmServerState = 'idle';
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private opts: LlmServerOptions;
  private readyPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  /**
   * Consecutive non-zero spawn-exit count. Reset to 0 by `noteSuccess()`
   * (called after every successful chat completion). Signal-killed exits
   * (`code === null`) are *not* counted — those are our own SIGTERM/SIGKILL
   * during graceful idle shutdown.
   */
  private failureCount = 0;
  /** Latched once `failureCount` hits 3; surfaced via `MODEL_UNUSABLE`. */
  private unusable = false;

  constructor(opts: LlmServerOptions = {}) {
    this.opts = { idleShutdownMs: 2 * 60_000, ...opts };
  }

  get state(): LlmServerState {
    return this._state;
  }

  getPort(): number | null {
    return this.port;
  }

  /**
   * Ensure a server is running and reset the idle timer. Safe to call
   * concurrently — overlapping calls share a single spawn.
   *
   * Throws `MODEL_UNUSABLE` if three consecutive spawns have ended in a
   * non-zero exit code without an intervening `noteSuccess()` — the model
   * is presumed broken (corrupt weights, OOM on every load, etc.) and the
   * caller should fall back / surface a user-facing error instead of
   * burning more time on spawn churn.
   */
  async ensure(): Promise<void> {
    if (this.unusable) {
      throw new Error('MODEL_UNUSABLE');
    }
    if (this._state === 'running') {
      this.armIdleTimer();
      return;
    }
    if (this._state === 'starting' && this.readyPromise) {
      this.armIdleTimer();
      return this.readyPromise;
    }
    const wasStopping = this._state === 'stopping';
    if (wasStopping && this.stopPromise) {
      await this.stopPromise;
    }
    this._state = 'starting';
    this.readyPromise = this.doStart();
    try {
      await this.readyPromise;
      this._state = 'running';
      // When transitioning out of a stopping cycle, skip arming the idle
      // timer so the caller's next real request is what re-arms it. This
      // also prevents fake-timer drainage tests from looping forever.
      if (!wasStopping) this.armIdleTimer();
    } finally {
      this.readyPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    const result = await (this.opts.spawnFn ?? this.realSpawn.bind(this))();
    this.proc = result.proc;
    this.port = result.port;
    // `.once` (not `.on`) — the proc is never reused across spawns, and a
    // long-running test harness that recycles a fake EventEmitter would
    // otherwise accumulate listeners on each ensure() / exit cycle.
    this.proc.once('exit', (code) => {
      this._state = 'idle';
      this.proc = null;
      this.port = null;
      // Signal-killed exits arrive with `code === null` (signal name is in
      // the second handler arg). Those are us — graceful idle shutdown via
      // SIGTERM/SIGKILL — and must not bump the failure counter. Anything
      // non-zero and non-null is the process dying on its own.
      if (code !== 0 && code !== null) {
        this.failureCount += 1;
        if (this.failureCount >= 3) {
          this.unusable = true;
        }
      }
    });
  }

  /**
   * Called by the backend after every successful chat completion. Resets
   * the consecutive-failure counter so a model that crashes once but then
   * recovers doesn't get latched as `MODEL_UNUSABLE` later in the session.
   */
  noteSuccess(): void {
    this.failureCount = 0;
  }

  private realSpawn = async (): Promise<SpawnResult> => {
    // Re-read env at spawn time, not just at construction. dev:desktop:hot
    // may set SUBCAST_LLM_BINARY_PATH after the singleton was first
    // touched (e.g. by an early /api/desktop/llm/status probe), and we
    // don't want the singleton latched into a permanently-broken state
    // when the env eventually shows up.
    const binaryPath = this.opts.binaryPath ?? process.env.SUBCAST_LLM_BINARY_PATH;
    if (!binaryPath) {
      throw new Error(
        'LLM_BINARY_MISSING: llama-server binary path is not configured. ' +
        'In dev:desktop:hot mode, install via `brew install llama.cpp` or ' +
        'run `node scripts/fetch-llama-server.mjs`. In production builds, ' +
        'this should never happen — reinstall Subcast.',
      );
    }
    // Resolve `modelPath` at spawn time (not at construction) so the user
    // can switch tiers in Settings and have the next spawn pick up the new
    // model without restarting the app. `opts.modelPath` is a test seam —
    // real production reads from settings.
    let modelPath = this.opts.modelPath;
    if (!modelPath) {
      const llmModel = loadSettings().llmModel;
      if (!llmModel) {
        throw new Error('LLM_MODEL_NOT_CONFIGURED');
      }
      modelPath = llmModelPath(llmModel);
    }
    const proc = spawn(binaryPath, [
      '--model', modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.opts.preferredPort ?? 0),
      '--keep', '-1',
      '--n-gpu-layers', '999',
    ]);
    const port = await this.waitForListeningPort(proc, 30_000);
    // The "listening" log line fires the moment the HTTP socket binds —
    // but llama-server is still loading model weights at that point and
    // every request comes back `503 {"status":"loading model"}` until
    // load completes. Block here on `/health` so callers don't have to
    // retry mid-stream. 60s budget covers 14B Q4 cold mmap on slower
    // disks; smaller tiers usually clear in 1-3s.
    await this.waitForHealthy(port, 60_000);
    return { proc, port };
  };

  private async waitForHealthy(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`llama-server /health never returned OK within ${timeoutMs}ms (last: ${lastErr})`);
  }

  /**
   * Resolve with the TCP port llama-server announces on stdout/stderr.
   * Upstream llama.cpp prints two listening lines per spawn — we match
   * the first one to fire:
   *
   *   `main: HTTP server is listening, hostname: 127.0.0.1, port: 52157, ...`
   *   `srv  update_slots: server is listening on http://127.0.0.1:52157 - ...`
   *
   * The bind happens AFTER model load (which dominates the spawn latency
   * for 7B+ Q4), so a 30s budget is generous on cold mmap of a 4-9 GB
   * weights file. Rejects after `timeoutMs` — caller treats that as a
   * spawn failure.
   */
  private waitForListeningPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      // Two formats accepted: `listening, ... port: 52157` and
      // `listening on http://127.0.0.1:52157`. The `.*?` is non-greedy so
      // the port capture is the first numeric port-like token after
      // `listening`, not some unrelated number elsewhere in the line.
      const re = /listening[^\n]*?(?:port[:\s]+|:\/\/[^:]+:|[0-9.]+:)(\d{2,5})/i;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`llama-server did not announce listening port within ${timeoutMs}ms`));
      }, timeoutMs);
      const onChunk = (chunk: Buffer | string) => {
        const m = re.exec(String(chunk));
        if (m) {
          cleanup();
          resolve(Number(m[1]));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout?.off('data', onChunk);
        proc.stderr?.off('data', onChunk);
      };
      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', onChunk);
    });
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.opts.idleShutdownMs);
  }

  async stop(): Promise<void> {
    if (this._state !== 'running') return;
    this._state = 'stopping';
    this.stopPromise = this.doStop();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private doStop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.proc) {
        resolve();
        return;
      }
      const proc = this.proc;
      const onExit = () => {
        resolve();
      };
      proc.once('exit', onExit);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this._state === 'stopping') {
          proc.kill('SIGKILL');
          // exit handler still fires and resolves
        }
      }, 5_000);
    });
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this._state === 'running') void this.stop();
  }
}

// Lazy singleton — Nitro modules import via `getLlmServer()` instead of
// constructing their own. `binaryPath` is injected by Electron main
// (`desktop/nitroEmbed.ts` sets `SUBCAST_LLM_BINARY_PATH`). `modelPath`
// is intentionally NOT set here — `realSpawn()` reads it from
// `loadSettings().llmModel` at spawn time so tier switches in the
// Settings UI take effect on the next ensure() without an app restart.
let instance: LlmServer | null = null;
export function getLlmServer(opts?: LlmServerOptions): LlmServer {
  if (instance === null) {
    instance = new LlmServer({
      binaryPath: process.env.SUBCAST_LLM_BINARY_PATH,
      ...opts,
    });
  }
  return instance;
}
