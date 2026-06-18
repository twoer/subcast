/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Child-process wrapper that converts the inherent footguns of raw
 * `spawn()` into an awaitable Promise with structured outcomes.
 *
 * Bakes in four things every call-site previously had to repeat:
 *   - External cancellation via `AbortSignal` (SIGTERM, escalating to
 *     SIGKILL after `killGraceMs`).
 *   - Per-call `timeoutMs` ceiling, also enforced via the same SIGTERM
 *     → SIGKILL ladder.
 *   - Head + tail ring-buffer capture of stdout/stderr so a chatty
 *     child can't OOM the parent on a long run.
 *   - `logEvent` traces at spawn / kill / exit so the diagnostic JSONL
 *     captures every subprocess transition without the caller wiring
 *     it up.
 *
 * Non-zero exit is NOT thrown — the caller inspects `result.code`.
 * Cancellation / timeout reject with the typed errors below so the
 * worker can map them onto the right user-facing status.
 */

import { spawn } from 'node:child_process';
import { logEvent } from './log';

/**
 * Thrown by `runProcess` when the child exceeded `timeoutMs`. The child
 * has already been signalled (SIGTERM → SIGKILL escalation).
 */
export class ProcessTimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'ProcessTimeoutError';
  }
}

/**
 * Thrown by `runProcess` when an external `AbortSignal` fired. The child
 * has been signalled. Callers in cancellation paths can swallow this.
 */
export class ProcessAbortedError extends Error {
  constructor(public readonly label: string) {
    super(`${label} aborted`);
    this.name = 'ProcessAbortedError';
  }
}

export interface RunProcessOptions {
  /**
   * External cancellation hook. When the signal fires, the child is
   * killed (SIGTERM, escalating to SIGKILL after `killGraceMs`).
   */
  signal?: AbortSignal;
  /**
   * Hard upper bound. Exceeding it kills the child and the promise
   * rejects with `ProcessTimeoutError`. Unset = no timeout.
   */
  timeoutMs?: number;
  /** SIGTERM → SIGKILL grace period. Default 2000ms. */
  killGraceMs?: number;
  /**
   * Per-stream byte cap (head half + tail half). When stdout or stderr
   * exceeds this, the middle is dropped and `truncated` is set. Default
   * 256 KiB per stream.
   */
  maxBufferBytes?: number;
  /** Short identifier used in structured logs (e.g. `whisper-cli`). */
  label: string;
}

export interface RunProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True if stdout or stderr was truncated due to `maxBufferBytes`. */
  truncated: boolean;
  durationMs: number;
}

/**
 * Keeps the first `halfLimit` chars verbatim, then a rolling window of
 * the last `halfLimit` chars. The middle is dropped on `toString`.
 */
class HeadTailBuffer {
  private head = '';
  private tail = '';
  private truncated = false;

  constructor(private readonly halfLimit: number) {}

  append(text: string): void {
    if (this.head.length < this.halfLimit) {
      const room = this.halfLimit - this.head.length;
      if (text.length <= room) {
        this.head += text;
        return;
      }
      this.head += text.slice(0, room);
      this.appendTail(text.slice(room));
    } else {
      this.appendTail(text);
    }
  }

  private appendTail(text: string): void {
    this.truncated = true;
    this.tail += text;
    if (this.tail.length > this.halfLimit) {
      this.tail = this.tail.slice(this.tail.length - this.halfLimit);
    }
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  toString(): string {
    if (!this.truncated) return this.head;
    return `${this.head}\n…[truncated]…\n${this.tail}`;
  }
}

/**
 * Spawn a child and wait for it to exit, with timeout / abort / capped
 * stdio capture / structured logging baked in.
 *
 * Non-zero exit code is **not** an error — caller inspects `result.code`.
 * Spawn errors (ENOENT, EACCES) reject as-is. Cancellation / timeout
 * reject with `ProcessAbortedError` / `ProcessTimeoutError` after the
 * child has been signalled.
 */
export function runProcess(
  cmd: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  const { signal, timeoutMs, label } = opts;
  const killGraceMs = opts.killGraceMs ?? 2000;
  const halfLimit = Math.max(1, Math.floor((opts.maxBufferBytes ?? 256 * 1024) / 2));
  const startedAt = Date.now();

  return new Promise<RunProcessResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProcessAbortedError(label));
      return;
    }

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = proc.pid ?? -1;
    logEvent({ level: 'debug', event: 'spawn_start', label, pid, argc: args.length });

    const stdoutBuf = new HeadTailBuffer(halfLimit);
    const stderrBuf = new HeadTailBuffer(halfLimit);

    proc.stdout.on('data', (d: Buffer) => stdoutBuf.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => stderrBuf.append(d.toString()));

    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let sigkillHandle: NodeJS.Timeout | null = null;
    let killReason: 'timeout' | 'abort' | null = null;

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (sigkillHandle) clearTimeout(sigkillHandle);
      signal?.removeEventListener('abort', onAbort);
    };

    const killChild = (reason: 'timeout' | 'abort'): void => {
      if (settled || killReason) return;
      killReason = reason;
      logEvent({ level: 'warn', event: 'spawn_kill', label, pid, reason });
      try {
        proc.kill('SIGTERM');
      } catch {
        // child already gone
      }
      sigkillHandle = setTimeout(() => {
        if (settled) return;
        logEvent({ level: 'warn', event: 'spawn_sigkill', label, pid, reason });
        try {
          proc.kill('SIGKILL');
        } catch {
          // child already gone
        }
      }, killGraceMs);
    };

    function onAbort(): void {
      killChild('abort');
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => killChild('timeout'), timeoutMs);
    }

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      logEvent({
        level: 'error',
        event: 'spawn_error',
        label,
        pid,
        msg: err instanceof Error ? err.message : String(err),
      });
      reject(err);
    });

    proc.on('close', (code, sigName) => {
      if (settled) return;
      settled = true;
      cleanup();
      const durationMs = Date.now() - startedAt;
      const stdout = stdoutBuf.toString();
      const stderr = stderrBuf.toString();
      const truncated = stdoutBuf.isTruncated || stderrBuf.isTruncated;

      // When the child died for an external reason (non-zero exit or
      // signal we didn't send), surface the last 500 chars of stderr
      // and bump the level to warn. Diagnostic bundles previously
      // showed `code: -1, sigName: <hashed>` with no clue why —
      // attaching the actual error message turns a 30-minute support
      // round-trip into a one-line read.
      const externalDeath = killReason === null && (code !== 0 || sigName !== null);
      const stderrTail = externalDeath && stderr ? stderr.slice(-500) : undefined;

      logEvent({
        level: killReason || externalDeath ? 'warn' : 'debug',
        event: 'spawn_exit',
        label,
        pid,
        code: code ?? -1,
        sigName: sigName ?? null,
        durationMs,
        truncated,
        killReason,
        ...(stderrTail ? { stderrTail } : {}),
      });

      if (killReason === 'timeout') {
        reject(new ProcessTimeoutError(label, timeoutMs!));
        return;
      }
      if (killReason === 'abort') {
        reject(new ProcessAbortedError(label));
        return;
      }
      resolve({
        code: code ?? 1,
        signal: sigName ?? null,
        stdout,
        stderr,
        truncated,
        durationMs,
      });
    });
  });
}
