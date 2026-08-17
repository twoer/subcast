/* SPDX-License-Identifier: Apache-2.0 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';

import { loadSettings } from './settings';
import { logEvent } from './log';
import { waitForSidecarPortOpen } from './sidecarAnnounce';
import { WHISPER_SERVER_PATH, whisperModelPath } from './whisperPaths';

export type WhisperServerState = 'idle' | 'starting' | 'running' | 'stopping';

export interface SpawnResult {
  proc: ChildProcess;
  port: number;
}

export interface WhisperServerOptions {
  binaryPath?: string;
  modelPath?: string;
  threads?: number;
  idleShutdownMs?: number;
  /** Test seam — defaults to real spawn-and-wait-for-port. */
  spawnFn?: () => Promise<SpawnResult>;
}

export interface WhisperServerSnapshot {
  state: WhisperServerState;
  idleShutdownMs: number;
  idleDeadlineAt: number | null;
}

/**
 * Lifecycle owner for the whisper-server sidecar, mirroring `LlmServer`.
 * Keeping the whisper.cpp model resident removes the per-chunk
 * spawn + mmap cost (measured ~0.6 s/chunk on large-v3-turbo — the
 * chunk loop then pays pure inference + a ~50 ms HTTP round trip).
 *
 * Unlike llama-server, whisper-server cannot discover a free port
 * itself: it prints the *requested* port on its listening line, so
 * `--port 0` would announce `:0` while the OS binds an ephemeral port.
 * We therefore probe a free TCP port before every spawn and pass it
 * explicitly.
 *
 * State machine (identical semantics to LlmServer):
 *
 *   idle ──ensure()──▶ starting ──spawn resolves──▶ running
 *                          │                            │ idle timer
 *                          │                            ▼
 *                          │                        stopping
 *                          │                            │ proc exits
 *                          ▼                            ▼
 *                  (ensure() during stopping re-enters starting once
 *                   stop completes) ──────────────────▶ idle
 */
export class WhisperServer {
  /** Monotonic spawn counter — correlates crash logs with spawn cycles. */
  private static spawnGeneration = 0;
  private _state: WhisperServerState = 'idle';
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDeadlineAt: number | null = null;
  private opts: WhisperServerOptions;
  private readyPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  /** Consecutive non-zero spawn exits; latches `unusable` at 3 (see LlmServer). */
  private failureCount = 0;
  private unusable = false;

  constructor(opts: WhisperServerOptions = {}) {
    this.opts = { idleShutdownMs: 2 * 60_000, ...opts };
  }

  get state(): WhisperServerState {
    return this._state;
  }

  getPort(): number | null {
    return this.port;
  }

  snapshot(): WhisperServerSnapshot {
    return {
      state: this._state,
      idleShutdownMs: this.opts.idleShutdownMs ?? 0,
      idleDeadlineAt: this.idleDeadlineAt,
    };
  }

  async ensure(): Promise<void> {
    if (this.unusable) {
      throw new Error('WHISPER_SERVER_UNUSABLE');
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
      if (!wasStopping) this.armIdleTimer();
    } finally {
      this.readyPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    const result = await (this.opts.spawnFn ?? this.realSpawn.bind(this))();
    this.proc = result.proc;
    this.port = result.port;
    const generation = ++WhisperServer.spawnGeneration;
    this.proc.once('exit', (code) => {
      this._state = 'idle';
      this.proc = null;
      this.port = null;
      this.clearIdleTimer();
      // Signal-killed exits (`code === null`) are our own idle shutdown.
      // Anything else is a crash: the next chunk's ensure() silently
      // re-spawns (≈1-2 s model reload) and, without this log, the cost
      // shows up only as mysterious multi-second inter-chunk gaps.
      if (code !== 0 && code !== null) {
        logEvent({
          level: 'warn',
          event: 'whisper_server_crashed',
          code,
          generation,
          failureCount: this.failureCount + 1,
        });
        this.failureCount += 1;
        if (this.failureCount >= 3) {
          this.unusable = true;
        }
      } else if (code === 0) {
        logEvent({ level: 'debug', event: 'whisper_server_exited', code, generation });
      }
    });
  }

  /** Reset the failure counter after a successful inference request. */
  noteSuccess(): void {
    this.failureCount = 0;
  }

  private async realSpawn(): Promise<SpawnResult> {
    const binaryPath = this.opts.binaryPath ?? WHISPER_SERVER_PATH;
    if (!existsSync(binaryPath)) {
      throw new Error(
        `WHISPER_SERVER_BINARY_MISSING: ${binaryPath} not staged. ` +
        'Run scripts/fetch-whisper-cli.mjs (it stages whisper-cli and whisper-server together). ' +
        'Transcription falls back to the whisper-cli path.',
      );
    }
    // Resolve the model at spawn time so Settings tier switches take
    // effect on the next spawn without an app restart (LlmServer pattern).
    let modelPath = this.opts.modelPath;
    if (!modelPath) {
      const model = loadSettings().whisperModel ?? 'base';
      modelPath = whisperModelPath(model);
      if (!existsSync(modelPath)) {
        throw new Error(`WHISPER_MODEL_NOT_FOUND: ${modelPath}`);
      }
    }
    const port = await pickFreePort();
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      // Match the CLI path's language default; per-request `language`
      // overrides this anyway, but the server default must not pin `en`.
      '-l', 'auto',
    ];
    if (typeof this.opts.threads === 'number') {
      args.push('-t', String(this.opts.threads));
    }
    const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Readiness = our chosen port accepting connections. whisper.cpp
    // binds only after model load (~20 s cold for the 1.6 GB turbo
    // tier); its stdout "listening" line is block-buffered under pipes
    // and can't be used as a signal. Early death fast-fails with the
    // stderr tail.
    await waitForSidecarPortOpen(proc, port, 60_000, 'whisper-server');
    logEvent({
      level: 'debug',
      event: 'whisper_server_spawned',
      port,
      generation: WhisperServer.spawnGeneration + 1,
    });
    return { proc, port };
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleDeadlineAt = Date.now() + (this.opts.idleShutdownMs ?? 0);
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.opts.idleShutdownMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleDeadlineAt = null;
  }

  async stop(): Promise<void> {
    if (this._state !== 'running') {
      this.clearIdleTimer();
      return;
    }
    this.clearIdleTimer();
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
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this._state === 'stopping') {
          proc.kill('SIGKILL');
        }
      }, 5_000);
    });
  }

  dispose(): void {
    this.clearIdleTimer();
    if (this._state === 'running') void this.stop();
  }
}

/** Grab an OS-assigned free TCP port (listen on :0, read it, close). */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('failed to probe free port'))));
    });
  });
}

/**
 * CPU threads for decode. Measured on M3 Pro + large-v3-turbo: -t 8
 * inference ~2.6 s/30 s chunk vs ~4.3 s with the default 4 — decode is
 * CPU-side and rewards threads; capped so the UI/llama-server keep cores.
 */
function whisperThreads(): number {
  const cores = cpus().length;
  return Math.max(4, Math.min(8, cores - 2));
}

// Lazy singleton (getLlmServer pattern). `binaryPath` comes from the
// packaged resources dir via whisperPaths; `modelPath` stays unset so
// spawn re-reads the Settings tier.
type WhisperServerGlobal = typeof globalThis & {
  __subcastWhisperServer?: WhisperServer | null;
};
const whisperServerGlobal = globalThis as WhisperServerGlobal;

export function getWhisperServer(opts?: WhisperServerOptions): WhisperServer {
  if (!whisperServerGlobal.__subcastWhisperServer) {
    whisperServerGlobal.__subcastWhisperServer = new WhisperServer({ threads: whisperThreads(), ...opts });
  }
  return whisperServerGlobal.__subcastWhisperServer;
}
