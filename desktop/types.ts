/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Surface exposed from the Electron preload to the renderer.
 *
 * Read in the browser via `(window as Window & { subcast: SubcastWindowAPI }).subcast`
 * or the typed `useDesktop()` composable in `app/composables/useDesktop.ts`.
 *
 * Note on `apiToken`: deliberately NOT in this surface. The session token
 * is injected by the main process at the network layer via
 * `webRequest.onBeforeSendHeaders` (desktop/main.ts), so the renderer
 * never holds it. This is defense-in-depth — an XSS payload still can't
 * read it from `window.subcast` or DevTools.
 */
export interface SubcastWindowAPI {
  isDesktop: true;
  platform: NodeJS.Platform;
  appVersion: string;
  /** Port Nitro is actually listening on (51301 by default, random fallback). */
  apiPort: number;
}

/**
 * Function surface exposed alongside SubcastWindowAPI on `window.subcast`.
 * Kept separate because functions can't be JSON-serialized through
 * webPreferences.additionalArguments — only the data half is, the rest is
 * wired through contextBridge directly in preload.ts.
 */
export interface SubcastWindowFns {
  /**
   * Subscribe to "open this file" events coming from the OS shell:
   *   - macOS Finder "Open With → Subcast"
   *   - macOS dock drag-drop
   *   - Windows "Open With" via file association
   *   - Second-instance launches with a file path arg
   *
   * Callback fires once per delivered path. Paths are validated server-side;
   * the renderer treats them as opaque strings.
   */
  onOpenFile(callback: (path: string) => void): void;
  /**
   * Subscribe to navigation requests coming from the main process (menu
   * "About Subcast", tray actions, etc.). The renderer should use
   * vue-router to push to the requested path; absolute paths only.
   */
  onNavigate(callback: (path: string) => void): void;
  /**
   * Subscribe to desktop shell requests to pause active media, e.g. when the
   * main window is hidden to tray or minimized.
   */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- returning void (no unsubscribe needed) is a valid "optional cleanup" contract
  onPauseMedia(callback: (reason: 'hide' | 'minimize') => void): (() => void) | void;
}

declare global {
  interface Window {
    subcast?: SubcastWindowAPI;
  }
}
