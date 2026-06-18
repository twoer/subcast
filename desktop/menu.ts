/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Application menu wiring (decision 29).
 *
 *   - macOS: keep Electron's default app menu (the leftmost "Subcast"
 *     dropdown with About / Hide / Quit / Services etc.) plus a custom
 *     Help menu with our own action items.
 *   - Windows / Linux: strip the menu bar entirely; we expose actions
 *     through the tray menu instead. A frameless window without a
 *     top-of-window menu strip is the standard desktop-app look.
 *
 * "About Subcast", Export Diagnostics, and Check for Updates are stubs
 * here — Phase 3.4 / 3.5 / 4 wire them up. The placeholder items show
 * a dialog so the user understands they're not broken, just pending.
 */

import { app, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { i18n } from './i18n.js';

const ISSUES_URL = 'https://github.com/twoer/subcast/issues/new';

export interface MenuWiring {
  onQuit: () => void;
  onAbout: () => void;
  onHelp: () => void;
  onExportDiagnostics: () => void;
  onCheckForUpdates: () => void;
}

function buildHelpSubmenu(wiring: MenuWiring): MenuItemConstructorOptions {
  const m = i18n().menu;
  return {
    role: 'help',
    submenu: [
      {
        label: m.documentation,
        click: () => wiring.onHelp(),
      },
      {
        label: m.reportIssue,
        click: () => void shell.openExternal(ISSUES_URL),
      },
      { type: 'separator' },
      {
        label: m.exportDiagnostics,
        click: () => wiring.onExportDiagnostics(),
      },
      {
        label: m.checkForUpdates,
        click: () => wiring.onCheckForUpdates(),
      },
    ],
  };
}

function buildMacTemplate(wiring: MenuWiring): MenuItemConstructorOptions[] {
  const m = i18n().menu;
  return [
    // First entry is auto-promoted to the app menu on macOS.
    {
      label: app.name,
      submenu: [
        {
          label: m.about,
          click: () => wiring.onAbout(),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: m.quit,
          accelerator: 'Command+Q',
          click: () => wiring.onQuit(),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      role: 'windowMenu',
    },
    buildHelpSubmenu(wiring),
  ];
}

export function installAppMenu(wiring: MenuWiring): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacTemplate(wiring)));
  } else {
    // Decision 29: no menu bar on Windows. Actions live in the tray.
    Menu.setApplicationMenu(null);
  }
}
