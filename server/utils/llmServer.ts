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
   */
  async ensure(): Promise<void> {
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
    this.proc.on('exit', (code) => {
      this._state = 'idle';
      this.proc = null;
      this.port = null;
      // Failure-counter wiring lands in Task 1.5; for now just log the exit.
      void code;
    });
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
    // Port-from-stdout parsing arrives in Task 1.3; for now reject so
    // tests must inject spawnFn.
    void proc;
    throw new Error('LlmServer.realSpawn requires Task 1.3 (port parsing) — inject spawnFn in tests');
  };

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
