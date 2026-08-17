/* SPDX-License-Identifier: Apache-2.0 */

import { spawn, type ChildProcess } from 'node:child_process';
import { llmModelPath } from '../../desktop/modelManager/llmInstall';
import { loadSettings } from './settings';
import { logEvent } from './log';
import { waitForSidecarListening } from './sidecarAnnounce';
import { activeRuntimeProfile, type RuntimeProfile } from './runtimeProfile';
import type { LlmModelId } from '#shared/llmModels';

export type LlmServerState = 'idle' | 'starting' | 'running' | 'stopping';

export interface SpawnResult {
  proc: ChildProcess;
  port: number;
}

export interface LlmServerSpawnRequest {
  modelId: string;
  modelPath: string;
  runtimeProfile: RuntimeProfile;
}

export interface ModelLease {
  endpoint: string;
  modelId: string;
  modelPath: string;
  backend: 'llama-server';
  runtimeProfileId: string;
  coldStart: boolean;
}

export interface LlmServerOptions {
  binaryPath?: string;
  modelPath?: string;
  preferredPort?: number;
  idleShutdownMs?: number;
  /** Test seam — defaults to real spawn-and-wait-for-port. */
  spawnFn?: (request: LlmServerSpawnRequest) => Promise<SpawnResult>;
}

export interface LlmServerSnapshot {
  state: LlmServerState;
  modelId: string | null;
  runtimeProfileId: string | null;
  idleShutdownMs: number;
  idleDeadlineAt: number | null;
  activeRequests: number;
}

/**
 * argv for llama-server. Exported pure function so tests can pin the
 * concurrency-critical flags (`--parallel`, `--ctx-size`) without
 * spawning a real process.
 */
export function llamaServerSpawnArgs(
  modelPath: string,
  port: number,
  profile: RuntimeProfile = activeRuntimeProfile(),
): string[] {
  const args = [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--keep', '-1',
    '--n-gpu-layers', String(profile.gpuLayers),
    // llama-server divides ctx evenly across `--parallel` slots, so the
    // total is scaled from the runtime profile's per-slot context. The
    // standard profile keeps 8192/slot for Insight; entry profiles can
    // lower both context and concurrency to avoid OOM.
    '--ctx-size', String(profile.perSlotContext * profile.parallelSlots),
    '--parallel', String(profile.parallelSlots),
    // NOTE: do NOT pass `-fa`/`--flash-attn` — current llama.cpp builds
    // take a required value (`-fa on|off|auto`) and a bare `-fa` makes
    // the next flag its value, killing the process at argv parse
    // (b10435: `unknown value for --flash-attn: '--cache-reuse'`).
    // The build's default is `auto` = enabled wherever the backend
    // supports it, which is exactly what we want.
    //
    // Reuse the KV prefix across requests that share one (the
    // translate/polish system prompt) instead of re-prefilling it.
    '--cache-reuse', '256',
    // Pin weights in RAM so a backgrounded app doesn't page them out
    // mid-task (`--mlock`'s modern spelling).
    '--load-mode', profile.loadMode,
  ];
  if (profile.flashAttention !== 'auto') {
    args.push('--flash-attn', profile.flashAttention);
  }
  return args;
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
  private currentModelId: string | null = null;
  private currentModelPath: string | null = null;
  private currentRuntimeProfile: RuntimeProfile | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleDeadlineAt: number | null = null;
  private activeRequests = 0;
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
  /**
   * Consecutive 5xx count, reset by `noteSuccess()`. The process-exit
   * latch can't see a server that is alive but failing every request
   * (wedged GPU context, corrupted KV cache), so the backend reports
   * given-up 5xx here and we recycle the process ONCE: stop() now, the
   * next ensure() respawns from scratch. Never latches unusable — a
   * fresh spawn fixes most wedges, and a permanently broken spawn still
   * trips the exit latch on its own.
   */
  private httpFailureCount = 0;
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

  snapshot(): LlmServerSnapshot {
    return {
      state: this._state,
      modelId: this.currentModelId,
      runtimeProfileId: this.currentRuntimeProfile?.id ?? null,
      idleShutdownMs: this.opts.idleShutdownMs ?? 0,
      idleDeadlineAt: this.idleDeadlineAt,
      activeRequests: this.activeRequests,
    };
  }

  /**
   * Reset the idle-unload timer if the server is running; no-op
   * otherwise (never spawns). Called by long-lived waiters — e.g. a
   * pipelined polish worker polling for cues on a sparse-audio video —
   * so pending work keeps the model resident instead of paying a cold
   * reload at every >idle-window gap between super-batches.
   */
  touch(): void {
    if (this._state === 'running') this.armIdleTimer();
  }

  beginRequest(): () => void {
    this.activeRequests += 1;
    this.clearIdleTimer();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0 && this._state === 'running') {
        this.armIdleTimer();
      }
    };
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
    await this.ensureLease();
  }

  async ensureLease(request?: { modelId?: LlmModelId }): Promise<ModelLease> {
    if (this.unusable) {
      throw new Error('MODEL_UNUSABLE');
    }
    const spawnRequest = this.resolveSpawnRequest(request?.modelId);
    if (this._state === 'running') {
      if (
        this.currentModelId === spawnRequest.modelId
        && this.currentModelPath === spawnRequest.modelPath
        && this.currentRuntimeProfile?.id === spawnRequest.runtimeProfile.id
      ) {
        this.armIdleTimer();
        return this.currentLease(false);
      }
      await this.stop();
    }
    if (this._state === 'running') {
      this.armIdleTimer();
      return this.currentLease(false);
    }
    if (this._state === 'starting' && this.readyPromise) {
      this.armIdleTimer();
      await this.readyPromise;
      return this.currentLease(false);
    }
    const wasStopping = this._state === 'stopping';
    if (wasStopping && this.stopPromise) {
      await this.stopPromise;
    }
    this._state = 'starting';
    this.readyPromise = this.doStart(spawnRequest);
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
    return this.currentLease(true);
  }

  private currentLease(coldStart: boolean): ModelLease {
    if (
      this.port == null
      || this.currentModelId == null
      || this.currentModelPath == null
      || this.currentRuntimeProfile == null
    ) {
      throw new Error('llama-server has no complete lease after ensure');
    }
    return {
      endpoint: `http://127.0.0.1:${this.port}`,
      modelId: this.currentModelId,
      modelPath: this.currentModelPath,
      backend: 'llama-server',
      runtimeProfileId: this.currentRuntimeProfile.id,
      coldStart,
    };
  }

  private resolveSpawnRequest(modelId?: LlmModelId): LlmServerSpawnRequest {
    const testModelId = this.opts.modelPath || this.opts.spawnFn ? 'test' : undefined;
    const id = modelId ?? testModelId ?? loadSettings().llmModel;
    if (!id) {
      throw new Error('LLM_MODEL_NOT_CONFIGURED');
    }
    return {
      modelId: id,
      modelPath: this.opts.modelPath ?? (this.opts.spawnFn
        ? '/models/test.gguf'
        : llmModelPath(id as LlmModelId)),
      runtimeProfile: activeRuntimeProfile(),
    };
  }

  private async doStart(request: LlmServerSpawnRequest): Promise<void> {
    const result = await (this.opts.spawnFn ?? this.realSpawn.bind(this))(request);
    this.proc = result.proc;
    this.port = result.port;
    this.currentModelId = request.modelId;
    this.currentModelPath = request.modelPath;
    this.currentRuntimeProfile = request.runtimeProfile;
    // `.once` (not `.on`) — the proc is never reused across spawns, and a
    // long-running test harness that recycles a fake EventEmitter would
    // otherwise accumulate listeners on each ensure() / exit cycle.
    this.proc.once('exit', (code) => {
      this._state = 'idle';
      this.proc = null;
      this.port = null;
      this.currentModelId = null;
      this.currentModelPath = null;
      this.currentRuntimeProfile = null;
      this.activeRequests = 0;
      this.clearIdleTimer();
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
   * the consecutive-failure counters so a model that crashes once but
   * then recovers doesn't get latched as `MODEL_UNUSABLE` later in the
   * session.
   */
  noteSuccess(): void {
    this.failureCount = 0;
    this.httpFailureCount = 0;
  }

  /** Report a given-up HTTP 5xx; three consecutive recycle the process. */
  noteHttpFailure(): void {
    this.httpFailureCount += 1;
    if (this.httpFailureCount >= 3) {
      this.httpFailureCount = 0;
      logEvent({
        level: 'warn',
        event: 'llm_server_http_5xx_recycle',
        state: this._state,
      });
      if (this._state === 'running') void this.stop();
    }
  }

  private realSpawn = async (request: LlmServerSpawnRequest): Promise<SpawnResult> => {
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
    const proc = spawn(
      binaryPath,
      llamaServerSpawnArgs(request.modelPath, this.opts.preferredPort ?? 0, request.runtimeProfile),
    );
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
   * The bind happens AFTER model load (which dominates the spawn latency
   * for 7B+ Q4), so a 30s budget is generous on cold mmap of a 4-9 GB
   * weights file. See `sidecarAnnounce.ts` for the shared semantics
   * (listening-line match + fast-fail with stderr tail on early exit).
   */
  private waitForListeningPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
    return waitForSidecarListening(proc, timeoutMs, 'llama-server');
  }

  private armIdleTimer(): void {
    if (this.activeRequests > 0) {
      this.clearIdleTimer();
      return;
    }
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
    this.clearIdleTimer();
    if (this._state === 'running') void this.stop();
  }
}

// Lazy singleton — Nitro modules import via `getLlmServer()` instead of
// constructing their own. `binaryPath` is injected by Electron main
// (`desktop/nitroEmbed.ts` sets `SUBCAST_LLM_BINARY_PATH`). `modelPath`
// is intentionally NOT set here — `realSpawn()` reads it from
// `loadSettings().llmModel` at spawn time so tier switches in the
// Settings UI take effect on the next ensure() without an app restart.
type LlmServerGlobal = typeof globalThis & {
  __subcastLlmServer?: LlmServer | null;
};
const llmServerGlobal = globalThis as LlmServerGlobal;

export function getLlmServer(opts?: LlmServerOptions): LlmServer {
  if (!llmServerGlobal.__subcastLlmServer) {
    llmServerGlobal.__subcastLlmServer = new LlmServer({
      binaryPath: process.env.SUBCAST_LLM_BINARY_PATH,
      ...opts,
    });
  }
  return llmServerGlobal.__subcastLlmServer;
}
