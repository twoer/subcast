/* SPDX-License-Identifier: Apache-2.0 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SUBCAST_PATHS } from './db';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  level: LogLevel;
  event: string;
  msg?: string;
  taskId?: string;
  requestId?: string;
  [extra: string]: unknown;
}

/**
 * Filename convention for daily JSONL logs. Shared so the writer here,
 * the diagnostic ZIP exporter, the in-app viewer, and any future log
 * tooling all agree on the same pattern.
 */
export const LOG_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** How many days of historical logs the diagnostic export retains. */
export const LOG_RETENTION_DAYS = 7;

/** Build the absolute path for a given `YYYY-MM-DD` day. */
export function logFilePath(day: string): string {
  return join(SUBCAST_PATHS.logs, `${day}.jsonl`);
}

let initPromise: Promise<void> | null = null;
async function ensureLogDir(): Promise<void> {
  if (!initPromise) {
    initPromise = mkdir(SUBCAST_PATHS.logs, { recursive: true }).then(() => undefined);
  }
  return initPromise;
}

function todayPath(): string {
  const d = new Date();
  const day =
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0');
  return logFilePath(day);
}

// Health state for logEvent's own write path. logEvent is fire-and-forget,
// so a long-running disk-full / permission-denied condition would otherwise
// be invisible to operators. We count consecutive failures, throttle stderr
// noise, and expose a snapshot for the diagnostics endpoint to surface in
// the UI.
let consecutiveFailures = 0;
let totalFailures = 0;
let lastFailureMsg: string | null = null;
let lastFailureAt: number | null = null;
let lastSuccessAt: number | null = null;
let pendingWrite: Promise<void> = Promise.resolve();

export interface LogHealth {
  /** True when the most recent write attempt succeeded. */
  ok: boolean;
  /** Consecutive write failures since the last successful append. */
  consecutiveFailures: number;
  /** Lifetime failure count (survives recoveries; useful for trend monitoring). */
  totalFailures: number;
  /** Message of the most recent failure, if any. */
  lastError: string | null;
  /** Wall-clock of the most recent failure (ms epoch). */
  lastFailureAt: number | null;
  /** Wall-clock of the most recent successful write (ms epoch). */
  lastSuccessAt: number | null;
}

export function getLogHealth(): LogHealth {
  return {
    ok: consecutiveFailures === 0,
    consecutiveFailures,
    totalFailures,
    lastError: lastFailureMsg,
    lastFailureAt,
    lastSuccessAt,
  };
}

/**
 * Append a structured event to today's JSONL log under
 * `~/.subcast/logs/YYYY-MM-DD.jsonl`. Fire-and-forget by design — observability
 * must not break the request path — but failures are tracked via
 * `getLogHealth()` so persistent disk problems become visible.
 */
export function logEvent(entry: LogEntry): void {
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
  pendingWrite = ensureLogDir()
    .then(() => appendFile(todayPath(), line))
    .then(() => {
      if (consecutiveFailures > 0) {
        process.stderr.write(
          `[log] recovered after ${consecutiveFailures} consecutive write failure(s)\n`,
        );
        consecutiveFailures = 0;
      }
      lastSuccessAt = Date.now();
    })
    .catch((err) => {
      consecutiveFailures += 1;
      totalFailures += 1;
      lastFailureMsg = err instanceof Error ? err.message : String(err);
      lastFailureAt = Date.now();
      // Throttle stderr: announce the first failure, then every 100th.
      // Without this, a wedged disk would flood stderr with thousands of
      // identical errors per minute as the queue keeps logging.
      if (consecutiveFailures === 1 || consecutiveFailures % 100 === 0) {

        console.error(
          `[log] write failed (${consecutiveFailures}x consecutive):`,
          lastFailureMsg,
        );
      }
    });
}

/**
 * Test-only hook for fire-and-forget log writes. Production callers should use
 * `logEvent()` without awaiting; tests can await this to avoid timing races.
 */
export function _flushLogWritesForTest(): Promise<void> {
  return pendingWrite;
}
