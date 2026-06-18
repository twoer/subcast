/* SPDX-License-Identifier: Apache-2.0 */

/**
 * System tray (macOS menu bar / Windows notification area).
 *
 * Behavior contract (decision 11 + 29):
 *   - Closing the main window hides it; the app keeps running in the
 *     tray. Background tasks (transcription, translation, AI insights)
 *     continue.
 *   - Tray icon click toggles the window.
 *   - "Quit Subcast" from the tray menu sets `isQuitting = true` and
 *     calls `app.quit()` — only then does the close-event let the
 *     window close for real.
 *
 * Image assets:
 *   - macOS: `assets/tray/trayTemplate.png` + `@2x.png`. Filename ends in
 *     "Template" so the system auto-tints for light/dark menu bar.
 *   - Windows: `assets/tray/tray-win.png` (32×32).
 */

import { Menu, Tray, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from './i18n.js';

const here = dirname(fileURLToPath(import.meta.url));

interface TrayWiring {
  tray: Tray;
  /** Toggle target window visibility from the outside. */
  reveal: () => void;
}

/**
 * Build the tray menu. `onQuit` is the outward-facing hook the main
 * process uses to flip `isQuitting` before `app.quit()`.
 */
function buildMenu(opts: {
  onShow: () => void;
  onQuit: () => void;
  onExportDiagnostics: () => void;
  onCheckForUpdates: () => void;
}): Menu {
  const t = i18n().tray;
  return Menu.buildFromTemplate([
    {
      label: t.show,
      click: opts.onShow,
    },
    {
      label: t.checkForUpdates,
      click: opts.onCheckForUpdates,
    },
    {
      label: t.exportDiagnostics,
      click: opts.onExportDiagnostics,
    },
    { type: 'separator' },
    {
      label: t.quit,
      accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Control+Q',
      click: opts.onQuit,
    },
  ]);
}

function trayImagePath(): string {
  // `here` is the directory of the compiled trayMenu.js. In dev that's
  // desktop-dist/; in the packaged app it's inside the asar. `..`
  // points at the repo / installed-app root where `assets/` lives.
  const root = join(here, '..');
  if (process.platform === 'darwin') {
    return join(root, 'assets', 'tray', 'trayTemplate.png');
  }
  return join(root, 'assets', 'tray', 'tray-win.png');
}

export interface TrayCallbacks {
  onQuit: () => void;
  onExportDiagnostics: () => void;
  onCheckForUpdates: () => void;
}

export function installTray(window: BrowserWindow, callbacks: TrayCallbacks): TrayWiring {
  const path1x = trayImagePath();
  const image = nativeImage.createFromPath(path1x);
  if (process.platform === 'darwin') {
    // createFromPath does NOT auto-resolve `@2x.png` siblings — on retina
    // displays a 1x-only image renders blurry, so register the @2x file
    // as a 2.0 representation explicitly when present.
    const path2x = path1x.replace(/\.png$/, '@2x.png');
    if (existsSync(path2x)) {
      image.addRepresentation({ scaleFactor: 2.0, buffer: readFileSync(path2x) });
    }
    // setTemplateImage(true) makes the menu bar render the icon as a
    // tinted silhouette. Idempotent on empty images.
    image.setTemplateImage(true);
  }
  if (image.isEmpty()) {
    // An empty image still produces a Tray instance, but macOS renders
    // it as a zero-width invisible slot — the user sees the window
    // vanish on close with no menu bar handle to get it back. Log loud
    // so the next packaging regression shows up in the diagnostics
    // bundle instead of as a silent "where did my app go" bug.
    console.warn(
      `[subcast] tray image failed to load from ${path1x}; menu bar icon will be invisible. ` +
      'Verify electron-builder.config.cjs `files` includes assets/tray/**.',
    );
  }

  const tray = new Tray(image);
  tray.setToolTip('Subcast');

  const reveal = (): void => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  tray.on('click', () => {
    // macOS users expect tray click to toggle visibility, not just show.
    if (window.isVisible() && window.isFocused()) {
      window.hide();
    } else {
      reveal();
    }
  });

  tray.setContextMenu(buildMenu({
    onShow: reveal,
    onQuit: callbacks.onQuit,
    onExportDiagnostics: callbacks.onExportDiagnostics,
    onCheckForUpdates: callbacks.onCheckForUpdates,
  }));

  return { tray, reveal };
}
