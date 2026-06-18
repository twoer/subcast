/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Subscribe once to the desktop "open this file" IPC and rebroadcast it as
 * a `CustomEvent('subcast:open-file', { detail: path })` on `window`. The
 * home page (and any other listener) can `window.addEventListener` for it
 * without coupling to Electron internals.
 *
 * Phase 1.13 cut: plumbing only. Wiring the path into the actual upload
 * flow (a desktop-only `import-from-path` server endpoint) is deferred —
 * for now consumers receive the event and can decide what to do with it.
 *
 * `.client.ts` suffix ensures this only runs in browser context.
 */

import { useDesktop } from '~/composables/useDesktop';

export default defineNuxtPlugin(() => {
  const desktop = useDesktop();
  if (!desktop.isDesktop) return;

  desktop.onOpenFile((path: string) => {
    window.dispatchEvent(new CustomEvent('subcast:open-file', { detail: path }));
  });
});
