<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Root app shell. Two responsibilities:
 *
 *  1. Host the global `TooltipProvider` so every Tooltip in the tree
 *     shares a single open/close timer and `delayDuration` — without
 *     this each page would have to wrap its own provider and the
 *     200ms hover delay would silently drift if a page forgot to set it.
 *
 *  2. Subscribe to `window.subcast.onNavigate` so the Electron main
 *     process can ask the renderer to route somewhere (currently only
 *     used by the menu's "About Subcast" → /help#about). vue-router
 *     push keeps the existing window state instead of doing a full
 *     URL reload.
 */
import { TooltipProvider } from '~/components/ui/tooltip';

interface DesktopBridge {
  onNavigate?: (cb: (path: string) => void) => void;
}

// `useRouter` must be called at setup top-level — calling it inside an
// async lifecycle hook can lose the Vue instance context and silently
// return a stale / wrong router. Capture it here and close over it.
const router = useRouter();

onMounted(() => {
  const bridge = (window as Window & { subcast?: DesktopBridge }).subcast;
  if (!bridge?.onNavigate) {
    console.warn('[subcast] desktop bridge or onNavigate unavailable; in-app menu nav disabled');
    return;
  }
  bridge.onNavigate((path) => {
    if (typeof path !== 'string' || !path.startsWith('/')) return;
    void router.push(path).catch((err) => {
      console.error('[subcast] router.push failed for', path, err);
    });
  });
});
</script>

<template>
  <TooltipProvider>
    <NuxtPage />
  </TooltipProvider>
</template>
