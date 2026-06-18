<script setup lang="ts">
import type { TooltipProviderProps } from "reka-ui"
import { TooltipProvider } from "reka-ui"

// Default hover delay is 200ms — fast enough to feel responsive when the
// user is intentionally hovering an icon-only control, slow enough that
// cursor pass-through doesn't strobe the whole UI with popups.
const props = withDefaults(defineProps<TooltipProviderProps>(), {
  delayDuration: 200,
  skipDelayDuration: 300,
  disableHoverableContent: false,
})
</script>

<template>
  <TooltipProvider
    :delay-duration="props.delayDuration"
    :skip-delay-duration="props.skipDelayDuration"
    :disable-hoverable-content="props.disableHoverableContent"
  >
    <slot />
  </TooltipProvider>
</template>
