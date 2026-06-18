/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Last-resort process-level safety net. Runs as a Nitro plugin so the
 * handlers are installed once, after Nitro is fully bootstrapped.
 *
 * Two distinct philosophies:
 *
 *   - **unhandledRejection** — a Promise was rejected with no `.catch`.
 *     This is almost always a programmer mistake (missing await, missing
 *     catch). Logging and continuing is the right move: the affected
 *     request has already failed; killing the process would punish
 *     unrelated in-flight work.
 *
 *   - **uncaughtException** — synchronous throw escaped the call stack.
 *     Node's official guidance is to log and exit: the process state may
 *     be corrupted (half-mutated objects, leaked file handles). We log
 *     synchronously to stderr and let Node exit; in desktop mode the
 *     parent Electron process surfaces this as a fatal dialog.
 *
 * Idempotent: re-imports won't double-register because the listeners are
 * named and we check before adding.
 */

import { logEvent } from '../utils/log';

const TAG = 'subcast:errors';

function alreadyInstalled(): boolean {
  // Distinguish our listener from Node's default / test framework / Electron.
  return process.listeners('unhandledRejection').some((l) => (l as { _subcast?: boolean })._subcast === true);
}

export default defineNitroPlugin(() => {
  if (alreadyInstalled()) return;

  function onUnhandled(reason: unknown): void {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logEvent({
      level: 'error',
      event: 'unhandled_rejection',
      msg: err.message,
      stack: err.stack,
    });
  }
  (onUnhandled as { _subcast?: boolean })._subcast = true;
  process.on('unhandledRejection', onUnhandled);

  function onUncaught(err: Error): void {
    // Best-effort log. logEvent is fire-and-forget so we also write to
    // stderr synchronously — process is about to die.
    logEvent({
      level: 'error',
      event: 'uncaught_exception',
      msg: err.message,
      stack: err.stack,
    });
    process.stderr.write(`[${TAG}] uncaught exception: ${err.stack ?? err.message}\n`);
    // Give the log write a moment to flush, then exit. Code 1 signals
    // abnormal termination; Electron parent will catch and surface.
    setTimeout(() => process.exit(1), 100);
  }
  (onUncaught as { _subcast?: boolean })._subcast = true;
  process.on('uncaughtException', onUncaught);

  logEvent({ level: 'debug', event: 'error_handlers_installed' });
});
