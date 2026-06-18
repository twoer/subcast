/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Preload script — runs in the renderer process (not main). Bridges a typed
 * `window.subcast` surface so the SPA can detect desktop context.
 *
 * The renderer process doesn't inherit main's env vars, so main.ts passes
 * the API descriptor via `webPreferences.additionalArguments` (which lands
 * in `process.argv`). We parse the `--subcast-api=...` arg here.
 *
 * On top of the JSON descriptor we also expose `onOpenFile(callback)` — an
 * IPC subscription helper. It can't be serialized via additionalArguments,
 * so the function is wired through contextBridge directly in this preload.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { SubcastWindowAPI } from './types.js';

function parseApiFromArgv(): SubcastWindowAPI | null {
  const prefix = '--subcast-api=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return null;
  try {
    return JSON.parse(decodeURIComponent(arg.slice(prefix.length))) as SubcastWindowAPI;
  } catch {
    return null;
  }
}

const api = parseApiFromArgv();
if (api) {
  contextBridge.exposeInMainWorld('subcast', {
    ...api,
    onOpenFile: (callback: (path: string) => void) => {
      ipcRenderer.on('subcast:open-file', (_event, filePath: string) => callback(filePath));
    },
    // In-app navigation triggered from the main process (menu / tray).
    // The renderer subscribes once on mount and uses vue-router to push
    // to the requested path — keeping the existing window state instead
    // of doing a full URL reload.
    onNavigate: (callback: (path: string) => void) => {
      ipcRenderer.on('subcast:navigate', (_event, path: string) => callback(path));
    },
    // Tell the renderer to pause any active media before the desktop shell
    // hides or minimizes the window.
    onPauseMedia: (callback: (reason: 'hide' | 'minimize') => void) => {
      const listener = (_event: IpcRendererEvent, reason: 'hide' | 'minimize') => callback(reason);
      ipcRenderer.on('subcast:pause-media', listener);
      return () => {
        ipcRenderer.off('subcast:pause-media', listener);
      };
    },
  });
} else {
  console.warn('[subcast preload] no --subcast-api arg found; window.subcast unavailable');
}
