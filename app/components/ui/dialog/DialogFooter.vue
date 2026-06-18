<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end sm:gap-x-3',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
