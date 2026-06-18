/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Detect whether we're running inside the Electron desktop shell and read
 * the API surface preload exposed via `window.subcast`.
 *
 * Reactive: backed by `useState` so SSR (web mode) renders the web-mode
 * defaults, and client hydration mutates the shared state in place once
 * `window.subcast` is available. Templates that read `desktop.isDesktop`
 * re-render after detection — fixes the flash where LAN URL chips render
 * during SSR and then need to disappear in the Electron shell.
 *
 * The `onOpenFile` callback registrar is kept OUT of useState because
 * Nuxt serializes the state payload for hydration via devalue, which
 * throws `Cannot stringify a function`. It lives in a module-level let
 * that only the client mutates — server-side it's just the NOOP default.
 *
 * Do NOT destructure the returned object — destructuring loses access
 * to the property getters that drive reactivity. Hold the returned view
 * and access `desktop.isDesktop`, `desktop.appVersion`, etc. directly.
 */

interface DesktopApi {
  isDesktop: true;
  platform: NodeJS.Platform;
  appVersion: string;
  apiPort: number;
  onOpenFile?: (callback: (path: string) => void) => void;
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- returning void (no cleanup) is semantically correct for a "maybe return an unsubscribe" callback
  onPauseMedia?: (callback: (reason: 'hide' | 'minimize') => void) => (() => void) | void;
}

export interface DesktopReactiveState {
  isDesktop: boolean;
  platform: NodeJS.Platform | null;
  appVersion: string | null;
  apiPort: number | null;
}

const NOOP = (): void => { /* web mode — nothing to subscribe to */ };
const NOOP_UNSUBSCRIBE = (): void => { /* listener already absent */ };

let activeOnOpenFile: (cb: (path: string) => void) => void = NOOP;
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- see onPauseMedia above
let activeOnPauseMedia: (cb: (reason: 'hide' | 'minimize') => void) => (() => void) | void = NOOP;

export function hydrateDesktopStateFromBridge(
  state: DesktopReactiveState,
  bridge: DesktopApi | undefined,
): ((cb: (path: string) => void) => void) | null {
  if (!bridge?.isDesktop) return null;
  state.isDesktop = true;
  state.platform = bridge.platform;
  state.appVersion = bridge.appVersion;
  state.apiPort = bridge.apiPort;
  activeOnPauseMedia = bridge.onPauseMedia ?? NOOP;
  return bridge.onOpenFile ?? NOOP;
}

export interface DesktopView {
  readonly isDesktop: boolean;
  readonly platform: NodeJS.Platform | null;
  readonly appVersion: string | null;
  readonly apiPort: number | null;
  onOpenFile(callback: (path: string) => void): void;
  onPauseMedia(callback: (reason: 'hide' | 'minimize') => void): () => void;
}

export function useDesktop(): DesktopView {
  // Seed from `runtimeConfig.public.isDesktopServer` so SSR (dev:desktop:hot)
  // and client hydration agree from the first render — no flash of the
  // web-mode UI before window.subcast is detected.
  const config = useRuntimeConfig();
  const seedFromServer = Boolean(config.public.isDesktopServer);

  const state = useState<DesktopReactiveState>('subcast:desktop', () => ({
    isDesktop: seedFromServer,
    platform: null,
    appVersion: null,
    apiPort: null,
  }));

  if (import.meta.client) {
    const api = (window as Window & { subcast?: DesktopApi }).subcast;
    activeOnOpenFile = hydrateDesktopStateFromBridge(state.value, api) ?? activeOnOpenFile;
  }

  return {
    get isDesktop() { return state.value.isDesktop; },
    get platform() { return state.value.platform; },
    get appVersion() { return state.value.appVersion; },
    get apiPort() { return state.value.apiPort; },
    onOpenFile(cb) { activeOnOpenFile(cb); },
    onPauseMedia(cb) { return activeOnPauseMedia(cb) ?? NOOP_UNSUBSCRIBE; },
  };
}
