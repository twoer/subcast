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
  return join(SUBCAST_PATHS.logs, `${day}.jsonl`);
}

/**
 * Append a structured event to today's JSONL log under
 * `~/.subcast/logs/YYYY-MM-DD.jsonl`. Fire-and-forget; failures are logged to
 * stderr but never thrown — observability must not break the request path.
 *
 * Slice 4 is the seed; later slices add log retention pruning, debug-mode
 * pass-through of sensitive fields, and the diagnostic-bundle export (§9).
 */
export function logEvent(entry: LogEntry): void {
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n';
  ensureLogDir()
    .then(() => appendFile(todayPath(), line))
    .catch((err) => {
       
      console.error('[log] write failed:', err);
    });
}
