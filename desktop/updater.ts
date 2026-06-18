/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Auto-update wiring (Phase 4.1 — Windows only for now).
 *
 *   Windows: `electron-updater` polls GitHub Releases (owner/repo set in
 *            electron-builder.config.cjs `publish`) and silently installs
 *            differential updates on next launch. Initial check fires
 *            shortly after the main window is ready; subsequent checks
 *            run every 6 hours.
 *
 *   macOS:   manual "Check for Updates…" — wired in Phase 4.2 against
 *            the same Releases feed but without auto-install (codesigning
 *            isn't viable for an unsigned distribution).
 *
 *   Dev:     no-op. electron-updater hard-fails outside a packaged build
 *            ("Application is not packed and packaged app cannot be
 *            updated"). `app.isPackaged` is the cheap guard.
 *
 * Errors:
 *   The updater emits 'error' for everything (network blip, 404 on a
 *   non-Win artifact, signature mismatch, etc.). We log but don't
 *   surface — users on the launch path shouldn't be greeted by a
 *   "couldn't reach GitHub" dialog. Failures from a manual check (Phase
 *   4.2) will get their own UX.
 */

import { app } from 'electron';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function installUpdater(): void {
  if (!app.isPackaged) {
    console.log('[subcast] auto-updater disabled in unpackaged dev build');
    return;
  }
  if (process.platform !== 'win32') {
    console.log('[subcast] auto-updater Windows-only for now (macOS manual via Phase 4.2)');
    return;
  }

  // Dynamic import keeps electron-updater out of the main module graph
  // when we're not actually using it (mac builds, dev runs). The library
  // also reads `process.resourcesPath` on import, which is cleaner if we
  // delay until we know we want it.
  void import('electron-updater').then(({ autoUpdater }) => {
    autoUpdater.logger = {
      info: (...a: unknown[]) => console.log('[updater]', ...a),
      warn: (...a: unknown[]) => console.warn('[updater]', ...a),
      error: (...a: unknown[]) => console.error('[updater]', ...a),
      debug: () => { /* noisy; suppress */ },
    };
    autoUpdater.on('error', (err) => {
      console.warn('[updater] error:', err instanceof Error ? err.message : err);
    });

    // First check is fire-and-forget — checkForUpdatesAndNotify uses the
    // OS notification center for the "ready to install" prompt, so we
    // never block the renderer.
    void autoUpdater.checkForUpdatesAndNotify();

    intervalHandle = setInterval(() => {
      void autoUpdater.checkForUpdatesAndNotify();
    }, CHECK_INTERVAL_MS);
  }).catch((err) => {
    console.warn('[updater] failed to load electron-updater:', err);
  });
}

export function disposeUpdater(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
