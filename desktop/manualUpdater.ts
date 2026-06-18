/* SPDX-License-Identifier: Apache-2.0 */

/**
 * macOS manual updater (§ 6.4 / Phase 4.2).
 *
 * Why manual: macOS distribution stays unsigned per decision 9, which
 * makes the silent `electron-updater` path unworkable (Squirrel.Mac
 * insists on a Developer-ID-signed bundle). Instead we hit the GitHub
 * Releases API, compare versions, and prompt the user to open the
 * release page in their browser. The actual download + drag-to-Apps
 * step stays in the user's hands.
 *
 * Trigger points:
 *   - App menu  Help → Check for Updates…   (silent = false)
 *   - Tray menu  Check for Updates…          (silent = false)
 *   - 5 seconds after launch                 (silent = true)
 *
 * `silent` controls whether the "already up to date" outcome shows a
 * dialog. Background checks stay quiet; explicit user clicks always
 * show feedback.
 */

import { app, dialog, shell } from 'electron';
import { fmt, i18n } from './i18n.js';

const RELEASES_API = 'https://api.github.com/repos/twoer/subcast/releases/latest';
const SILENT_CHECK_DELAY_MS = 5_000;

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

let scheduledHandle: ReturnType<typeof setTimeout> | null = null;

/** Strip a leading `v` from a tag and split into integer parts. */
function parseVersion(raw: string): number[] {
  return raw.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
}

/** True iff `latest` is strictly newer than `current`. */
function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Check the latest GitHub release. When `silent`, only surfaces a
 * dialog if there's an update to apply. Errors are logged and (when
 * not silent) shown to the user so they don't think the click was a
 * no-op.
 */
export async function checkForUpdates(silent = false): Promise<void> {
  if (process.platform !== 'darwin') {
    // electron-updater handles win32; this module shouldn't run there.
    return;
  }

  const u = i18n().updates;
  let release: GithubRelease;
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    release = (await res.json()) as GithubRelease;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[manualUpdater] check failed:', detail);
    if (!silent) {
      await dialog.showMessageBox({
        type: 'warning',
        title: u.failedTitle,
        message: u.failedMessage,
        detail,
        buttons: ['OK'],
      });
    }
    return;
  }

  const latest = release.tag_name.replace(/^v/, '');
  const current = app.getVersion();

  if (!isNewer(latest, current)) {
    if (!silent) {
      await dialog.showMessageBox({
        type: 'info',
        title: u.upToDateTitle,
        message: fmt(u.upToDateMessage, { version: current }),
        buttons: ['OK'],
      });
    }
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: u.availableTitle,
    message: fmt(u.availableMessage, { latest }),
    detail: fmt(u.availableDetail, { current }),
    buttons: [u.openDownload, u.later],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal(release.html_url);
}

/**
 * Schedule a one-shot silent check `SILENT_CHECK_DELAY_MS` after launch.
 * Safe to call on non-macOS — it's a no-op there. Cancel via
 * `disposeManualUpdater()` on shutdown so we don't fire after exit.
 */
export function installManualUpdater(): void {
  if (process.platform !== 'darwin') return;
  if (!app.isPackaged) {
    console.log('[manualUpdater] disabled in unpackaged dev build');
    return;
  }
  scheduledHandle = setTimeout(() => {
    void checkForUpdates(true);
  }, SILENT_CHECK_DELAY_MS);
}

export function disposeManualUpdater(): void {
  if (scheduledHandle !== null) {
    clearTimeout(scheduledHandle);
    scheduledHandle = null;
  }
}
