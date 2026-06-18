<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Single-source-of-truth page shell.
 *
 * Before this component each page hand-rolled
 *   `<main class="min-h-dvh px-8 pb-12"><AppHeader /><content/></main>`
 * and let the document scroll. Two problems with that:
 *
 *   1. The native scrollbar runs the full window height — visually
 *      crossing the sticky AppHeader, which users read as "the
 *      scrollbar is overlapping the header".
 *   2. Five pages duplicated the wrapper, with subtle drift over time.
 *
 * Layout: `grid h-dvh grid-rows-[auto_1fr]`. Row 1 is the header
 * (intrinsic height); row 2 owns `overflow-y-auto`, so the scrollbar
 * lives inside the content region and starts *below* the header.
 *
 * The page passes its own `<AppHeader>` (and its page-specific props
 * — `lanUrl`, `showPrimaryNav`) via the `#header`
 * slot; default slot holds the scrollable content. We deliberately
 * don't move AppHeader into this shell because per-page prop
 * configuration would either require prop drilling here or a parallel
 * `useHeaderConfig` composable — slots keep the page in direct control.
 *
 * Player page opts out (`flex h-dvh overflow-hidden` with its own
 * inner scroll regions) — it doesn't need the shell.
 */
</script>

<template>
  <main class="grid h-dvh grid-rows-[auto_1fr] bg-background text-foreground">
    <slot name="header" />
    <div class="overflow-y-auto px-8 pt-6 pb-12">
      <slot />
    </div>
  </main>
</template>
