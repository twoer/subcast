/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Electron main process entry.
 *
 * Wiring through Phase 3.2:
 *   - Single-instance lock (decision 20): second launch focuses the
 *     existing window and forwards any file-path argv into it.
 *   - File-open IPC bridge: macOS `open-file`, Windows argv parsing, and
 *     second-instance argv all feed the `subcast:open-file` channel.
 *   - Nitro in-process on port 51301 (random fallback).
 *   - BrowserWindow loading http://127.0.0.1:<port>/setup-check.
 *   - First launch maximizes (decision 14); subsequent launches restore
 *     prior window state via electron-window-state.
 *   - Force dark theme via <html class="dark"> injection (decision 19).
 *   - Inject session token into preload via additionalArguments
 *     (decision 4).
 *   - System tray + close-to-tray (decisions 11 & 29). Closing the
 *     window hides it; Cmd+Q / tray Quit set `isQuitting = true` and
 *     trigger a real shutdown.
 *   - Application menu (decision 29). macOS keeps the default app menu
 *     + a custom Help menu; Windows strips the menu bar entirely.
 *
 * Not yet wired:
 *   - About dialog (Phase 3.4).
 *   - Export Diagnostics action (Phase 3.5).
 *   - Auto-updater (Phase 4).
 */

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import type { Tray } from 'electron';
import windowStateKeeper from 'electron-window-state';
import { existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundledBinaries, formatMissingForDialog, stripQuarantine } from './binaryCheck.js';
import { exportDiagnostics } from './diagnostics.js';
import { fmt, i18n } from './i18n.js';
import {
  checkForUpdates as manualCheckForUpdates,
  disposeManualUpdater,
  installManualUpdater,
} from './manualUpdater.js';
import { installAppMenu } from './menu.js';
import { seedBundledBaseModel } from './modelManager/seedBundledModel.js';
import { connectToDevServer, startNitro } from './nitroEmbed.js';
import { killOrphans } from './orphanCleanup.js';
import { resolveResourcesPath } from './paths.js';
import { installTray } from './trayMenu.js';
import { disposeUpdater, installUpdater } from './updater.js';
import type { SubcastWindowAPI } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
// preload.cjs (not .js) — the preload runs in Electron's sandboxed
// environment which requires CommonJS. The file is emitted by a
// separate tsconfig (tsconfig.preload.json) and renamed to .cjs by
// the build:desktop:main script so node treats it correctly under
// the project's "type": "module" package.json.
const PRELOAD_PATH = join(here, 'preload.cjs');

// Single-instance lock (decision 20). Without it, double-clicking the app
// can spin up two independent Electron processes — each binding its own
// Nitro on 51301-or-random, fighting over the SQLite file, etc.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let nitroApiToken: string | null = null;
let nitroApiPort: number | null = null;
/**
 * Flipped by tray "Quit", Cmd+Q via menu, or `before-quit` from any other
 * shutdown path. While false, intercepting the close event hides the
 * window instead of terminating the app.
 */
let isQuitting = false;
let shutdownDone = false;
/**
 * File paths delivered before the renderer is ready to receive IPC. Flushed
 * once `did-finish-load` fires. Bounded implicitly by user behavior — we
 * never expect more than a handful of pending files.
 */
const pendingOpenFiles: string[] = [];

/**
 * Extracts plausible file paths from a process argv slice. Filters Electron's
 * own flags and `--subcast-*` markers and only keeps entries that resolve to
 * an existing file on disk. Resilient by design — bad input is silently
 * skipped rather than crashing the main process.
 */
function extractFilePathsFromArgv(argv: readonly string[]): string[] {
  return argv
    .filter((a) => !a.startsWith('-') && !a.endsWith('electron') && !a.endsWith('Electron'))
    .filter((a) => isAbsolute(a) && existsSync(a));
}

function deliverOpenFile(path: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('subcast:open-file', path);
  } else {
    pendingOpenFiles.push(path);
  }
}

function focusExistingWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function pauseRendererMedia(reason: 'hide' | 'minimize'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('subcast:pause-media', reason);
}

function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

async function createMainWindow(api: SubcastWindowAPI): Promise<void> {
  // Restore prior window position/size; first launch = sensible defaults.
  // electron-window-state stores under userData/window-state.json.
  const winState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  const win = new BrowserWindow({
    show: false,           // show after did-finish-load to avoid flash
    x: winState.x,
    y: winState.y,
    width: winState.width,
    height: winState.height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff', // matches the SPA's light-theme background
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // preload runs in renderer process — main's env vars aren't inherited.
      // Pass desktop API surface via additionalArguments instead.
      additionalArguments: [`--subcast-api=${encodeURIComponent(JSON.stringify(api))}`],
    },
  });

  // Hook window-state restore (also persists size/position on close).
  winState.manage(win);

  // Decision 14: first launch maximizes. If we have no prior state (first run),
  // winState has no saved bounds — electron-window-state returns defaults and
  // we maximize on top.
  if (!winState.x && !winState.y) win.maximize();

  // Decision 19 (revised 2026-05-13): keep the SPA's default light theme
  // so desktop matches the existing web look 1:1. No more dark-class
  // injection. Future: hook this to a user-preferred theme setting.
  win.webContents.on('did-finish-load', () => {
    win.show();

    // Flush any file paths the OS delivered before the renderer was ready.
    while (pendingOpenFiles.length > 0) {
      const p = pendingOpenFiles.shift()!;
      win.webContents.send('subcast:open-file', p);
    }
  });

  // Open external links in the user's default browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close-to-tray (decision 11). The 'close' event fires *before*
  // 'closed' and can be cancelled. We only let it through when the app
  // is genuinely quitting (Cmd+Q, tray Quit, etc.).
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      pauseRendererMedia('hide');
      win.hide();
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });

  win.on('minimize', () => {
    pauseRendererMedia('minimize');
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Re-show the dock icon (macOS) when the user un-hides the window.
  win.on('show', () => {
    if (process.platform === 'darwin') void app.dock?.show();
  });

  mainWindow = win;

  // Land on /setup-check — it fast-forwards to / when everything is already
  // installed, and routes to /setup-wizard otherwise. The 404 case (web
  // mode reached by accident) falls back to / inside the page itself.
  await win.loadURL(api.apiPort
    ? `http://127.0.0.1:${api.apiPort}/setup-check`
    : 'about:blank');
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // Reap orphan sidecars left behind by a hard kill (Force Quit, OOM,
  // power loss). When Electron dies without running `before-quit`,
  // any running `llama-server` / `whisper-cli` is re-parented to PID 1
  // and continues to hold its TCP port — which makes the next launch
  // fail to bind. Cleanup is best-effort; failure here shouldn't
  // block boot. No-op on Windows (v1 doesn't ship AI sidecars there).
  try {
    const cleaned = await killOrphans(['llama-server', 'whisper-cli']);
    if (cleaned > 0) {
      console.log(`[subcast] killed ${cleaned} orphan sidecar(s) from prior crash`);
    }
  } catch (err) {
    console.warn(
      '[subcast] orphan cleanup skipped:',
      err instanceof Error ? err.message : err,
    );
  }

  // Capture any file paths the OS handed us via argv at launch (Windows
  // "Open with Subcast" / Subcast.exe video.mp4). macOS uses `open-file`
  // instead — already registered below before whenReady resolves.
  for (const p of extractFilePathsFromArgv(process.argv.slice(1))) {
    pendingOpenFiles.push(p);
  }

  // Pre-flight: sidecar binaries must be present before Nitro launches.
  // In packaged mode this is fatal — without these no transcription is
  // possible and silently failing at spawn time is worse than a clear
  // dialog at startup. In dev mode it's only a warning so contributors
  // who haven't run scripts/fetch-whisper-cli.mjs aren't blocked.
  const binCheck = checkBundledBinaries(resolveResourcesPath());

  // Strip macOS download-quarantine xattr from bundled binaries before
  // anything tries to spawn them. Without this, ad-hoc-signed sidecars
  // get killed with SIGABRT in 1-7ms by amfid when the user installed
  // from a browser-downloaded dmg. Idempotent + best-effort — no-op on
  // Windows/Linux and when the attribute is already absent.
  if (app.isPackaged) stripQuarantine(binCheck.resourcesPath);
  if (!binCheck.ok) {
    if (app.isPackaged) {
      const bm = i18n().binaryMissing;
      console.error(
        '[subcast] missing required binaries:',
        binCheck.missing.map((m) => m.name).join(', '),
      );
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: bm.title,
        message: bm.message,
        detail: `${bm.detailIntro}\n\n${formatMissingForDialog(binCheck.missing)}\n\n${bm.fixHint}`,
        buttons: [bm.openLogs, bm.reportIssue, bm.quit],
        defaultId: 2,
        cancelId: 2,
      });
      if (response === 0) {
        shell.openPath(join(app.getPath('userData'), 'logs'));
      } else if (response === 1) {
        const body = encodeURIComponent(
          '**Subcast — missing bundled binaries**\n' +
          `- version: ${app.getVersion()}\n` +
          `- platform: ${process.platform} (${process.arch})\n` +
          `- resourcesPath: ${binCheck.resourcesPath}\n` +
          '- missing:\n' +
          binCheck.missing.map((m) => `  - ${m.name} (${m.exists ? 'not executable' : 'not found'}): ${m.path}`).join('\n'),
        );
        shell.openExternal(`https://github.com/twoer/subcast/issues/new?body=${body}`);
      }
      app.quit();
      return;
    }
    // Dev / non-packaged: log and continue. The web-mode ffmpeg fallback
    // in ffmpegPaths.ts can rescue missing ffmpeg/ffprobe; missing
    // whisper-cli will fail at first transcribe, which is the dev
    // contract.
    console.warn(
      '[subcast] binary check (dev, non-fatal): missing',
      binCheck.missing.map((m) => m.name).join(', '),
    );
  }

  // Seed the bundled ggml-base.bin into userData if it isn't already
  // installed and the user hasn't explicitly dismissed it. Runs before
  // Nitro so the setup wizard's first /api/desktop/setup-status response
  // already sees the model as installed.
  const seedResult = seedBundledBaseModel(binCheck.resourcesPath, app.getPath('userData'));
  if (seedResult.status === 'seeded') {
    console.log(`[subcast] bundled ggml-base.bin symlinked into ${seedResult.destPath}`);
  } else if (seedResult.status === 'failed') {
    console.warn(
      `[subcast] failed to seed bundled ggml-base.bin (${seedResult.reason}); ` +
      'setup wizard will fall back to download.',
    );
  }

  let handle;
  try {
    // HMR dev mode: `scripts/dev-desktop-hot.mjs` runs `nuxt dev` externally
    // and points us at it via SUBCAST_DEV_URL + shared SUBCAST_API_TOKEN.
    // Skip the in-process Nitro embed so renderer edits hot-reload through
    // Vite. Production / `pnpm dev:desktop` still go through startNitro.
    const devUrl = process.env.SUBCAST_DEV_URL;
    handle = devUrl ? await connectToDevServer(devUrl) : await startNitro();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[subcast] Nitro failed to start:', message);
    const sf = i18n().startupFailure;
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: sf.title,
      message: sf.message,
      detail: `${message}\n\n${sf.causesIntro}`,
      buttons: [sf.openLogs, sf.reportIssue, sf.quit],
      defaultId: 2,
      cancelId: 2,
    });
    if (response === 0) {
      shell.openPath(join(app.getPath('userData'), 'logs'));
    } else if (response === 1) {
      const body = encodeURIComponent(
        '**Subcast failed to start**\n' +
        `- version: ${app.getVersion()}\n` +
        `- platform: ${process.platform} (${process.arch})\n` +
        `- error: ${message}\n\n` +
        '---\n[Please attach the most recent log file from Open Log Folder.]',
      );
      shell.openExternal(`https://github.com/twoer/subcast/issues/new?body=${body}`);
    }
    app.quit();
    return;
  }

  console.log(`[subcast] Nitro ready on ${handle.url}`);

  // Cache for the before-quit shutdown POST.
  nitroApiToken = handle.token;
  nitroApiPort = handle.port;

  // Inject the session token into every request the renderer makes to
  // 127.0.0.1:<port>. This is more reliable than the renderer-side
  // `$fetch.create` plugin, which doesn't survive Nuxt's static binding
  // of `$fetch` in production builds. webRequest filters fire at the
  // Electron net layer, before the request leaves the process.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${handle.port}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          'x-subcast-token': handle.token,
        },
      });
    },
  );

  // Surface what preload should expose to the renderer. The token is
  // deliberately omitted — the webRequest filter above injects it on
  // every outbound request, so renderer code never needs to see it.
  const api: SubcastWindowAPI = {
    isDesktop: true,
    platform: process.platform,
    appVersion: app.getVersion(),
    apiPort: handle.port,
  };

  await createMainWindow(api);

  if (mainWindow) {
    const runExportDiagnostics = (): void => {
      const d = i18n().diagnostics;
      void exportDiagnostics(mainWindow).then((res) => {
        if (!res.path) return;
        void dialog.showMessageBox(mainWindow!, {
          type: 'info',
          title: d.successTitle,
          message: d.successMessage,
          detail: fmt(d.successDetail, {
            count: res.logCount,
            bytes: res.bytes.toLocaleString(),
            path: res.path,
          }),
          buttons: ['OK'],
        });
      }).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        void dialog.showMessageBox(mainWindow!, {
          type: 'error',
          title: d.failureTitle,
          message: d.failureMessage,
          detail,
          buttons: ['OK'],
        });
      });
    };

    const runCheckForUpdates = (): void => {
      void manualCheckForUpdates(false);
    };

    tray = installTray(mainWindow, {
      onQuit: requestQuit,
      onExportDiagnostics: runExportDiagnostics,
      onCheckForUpdates: runCheckForUpdates,
    }).tray;
    installAppMenu({
      onQuit: requestQuit,
      // About lives as an in-app Help tab now (so it shares vue-i18n with the
      // rest of the app — the standalone window had its own i18n state
      // that didn't update when the user toggled language). Surface the
      // window if hidden, then ask the renderer to route to it.
      onAbout: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('subcast:navigate', '/help#about');
        }
      },
      onHelp: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('subcast:navigate', '/help');
        }
      },
      onExportDiagnostics: runExportDiagnostics,
      onCheckForUpdates: runCheckForUpdates,
    });
  }

  // Auto-update wiring. Windows gets the silent electron-updater poll;
  // macOS gets the manual updater (5s post-boot silent check + menu /
  // tray triggers). Both branches are dev-build no-ops via app.isPackaged.
  installUpdater();
  installManualUpdater();
}

// macOS-specific: Finder "Open With → Subcast" delivers paths via this event,
// not argv. Fires before whenReady on cold launch, so we register it eagerly.
app.on('open-file', (event, path) => {
  event.preventDefault();
  deliverOpenFile(path);
});

// Second-instance launches surface here instead of starting a new process
// (thanks to requestSingleInstanceLock). On Windows, argv is how the second
// instance receives the file path; on macOS, `open-file` covers it separately.
app.on('second-instance', (_event, argv) => {
  focusExistingWindow();
  for (const p of extractFilePathsFromArgv(argv.slice(1))) {
    deliverOpenFile(p);
  }
});

/**
 * Flush in-flight Nitro work before the process dies. event.preventDefault
 * defers the natural quit; once the shutdown POST settles (or times out)
 * we force-exit. Re-entrant calls bail out via `shutdownDone`.
 */
async function shutdownNitro(): Promise<void> {
  if (!nitroApiToken || !nitroApiPort) return;
  try {
    // Internal teardown budget: queue cancel (~2 s per running task) +
    // LlmServer.stop (SIGTERM grace 5 s + SIGKILL). Cap this fetch at 10 s
    // so a slow llama-server shutdown finishes BEFORE we app.exit(0) and
    // orphans the child. If we tied this to the same 5 s as the SIGKILL
    // grace, both timers raced and llama-server occasionally survived as
    // a launchd-reparented orphan that orphanCleanup had to mop up on
    // next boot.
    await fetch(`http://127.0.0.1:${nitroApiPort}/api/desktop/shutdown`, {
      method: 'POST',
      headers: { 'x-subcast-token': nitroApiToken },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn('[subcast] shutdown POST failed:', err instanceof Error ? err.message : err);
  }
}

// before-quit fires before windows are closed. We hijack it long enough to
// flush running Whisper / Translate / Insight tasks so the next launch
// doesn't have to triage zombie 'running' rows.
app.on('before-quit', (event) => {
  isQuitting = true;
  if (shutdownDone) return;
  event.preventDefault();
  // Detach the tray icon up-front so it doesn't linger past process exit
  // (macOS sometimes leaves a phantom icon otherwise).
  tray?.destroy();
  tray = null;
  disposeUpdater();
  disposeManualUpdater();
  void shutdownNitro().finally(() => {
    shutdownDone = true;
    app.exit(0);
  });
});

// Top-level safety net for the Electron main process. The renderer has
// its own error surface (Vue + DevTools); this catches main-process
// programmer bugs that would otherwise crash the whole app silently.
//   - unhandledRejection: log only. The originating promise's owner has
//     already failed; killing Electron would be over-reaction.
//   - uncaughtException: log, show a fatal dialog, then exit. Process
//     state may be corrupted — best practice is not to keep running.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[subcast] unhandled rejection:', err.stack ?? err.message);
});
process.on('uncaughtException', (err) => {
  console.error('[subcast] uncaught exception:', err.stack ?? err.message);
  try {
    // Resolve the real log directory at message-build time — on Windows
    // / Linux userData lives nowhere near `~/.subcast/`, so the
    // previously-hardcoded POSIX path sent users on a wild goose chase.
    // `app.isReady()` guards the rare pre-ready crash path; we fall
    // back to the literal POSIX hint there since `getPath` would throw.
    const logsHint = app.isReady()
      ? join(app.getPath('userData'), 'logs')
      : '~/.subcast/logs';
    dialog.showErrorBox(
      'Subcast — Unexpected Error',
      `${err.message}\n\nThe app will now exit. Please report this with the log file at ${logsHint}.`,
    );
  } catch {
    // dialog may not be available pre-ready or post-quit; ignore.
  }
  app.exit(1);
});

bootstrap().catch((err) => {
  console.error('[subcast] bootstrap failed:', err);
  app.quit();
});

// macOS standard: re-create window when dock icon clicked with no open windows.
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
    bootstrap().catch(console.error);
  }
});

// With the tray + close-to-tray contract, the window-all-closed default
// would terminate the app the moment the user clicks the X. Suppress the
// default exit so the tray icon keeps the process alive on Windows /
// Linux; on macOS the platform convention already keeps the app alive.
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});
