/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { spawn, type ChildProcess } from 'node:child_process';

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
    this.opts = { idleShutdownMs: 5 * 60_000, ...opts };
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
    if (!this.opts.binaryPath || !this.opts.modelPath) {
      throw new Error('LlmServer: binaryPath and modelPath must be set before spawn');
    }
    const proc = spawn(this.opts.binaryPath, [
      '--model', this.opts.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.opts.preferredPort ?? 0),
      '--keep', '-1',
      '--n-gpu-layers', '999',
    ]);
    const port = await this.waitForListeningPort(proc, 10_000);
    return { proc, port };
  };

  /**
   * Resolve with the TCP port llama-server announces on stdout/stderr.
   * Matches lines like `HTTP server listening on 127.0.0.1:51302` (also
   * tolerates IPv6 bracketed forms). Rejects after `timeoutMs` if no
   * announcement is seen — caller should treat that as a spawn failure.
   */
  private waitForListeningPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const re = /listening on (?:[0-9.]+|\[?[0-9a-f:]+\]?):(\d+)/i;
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
// constructing their own. Wiring up in Task 7.1 via env vars.
let instance: LlmServer | null = null;
export function getLlmServer(opts?: LlmServerOptions): LlmServer {
  if (instance === null) {
    instance = new LlmServer({
      binaryPath: process.env.SUBCAST_LLM_BINARY_PATH,
      // modelPath plumbed in Task 3.x once settings.llmModel is in place
      ...opts,
    });
  }
  return instance;
}
