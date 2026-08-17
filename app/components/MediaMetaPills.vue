<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { Clock3, HardDrive } from 'lucide-vue-next';
import { fmtBytes, fmtDuration } from '~/utils/format';

const props = defineProps<{
  durationS?: number | null;
  bytes: number;
}>();

const durationText = computed(() => fmtDuration(props.durationS));
const totalBytes = computed(() => Math.max(0, Number.isFinite(props.bytes) ? props.bytes : 0));
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
    <span
      v-if="durationText"
      class="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-muted/35 px-1.5 py-0.5 font-mono tabular-nums"
    >
      <Clock3 class="size-3 shrink-0" aria-hidden="true" />
      <span>{{ durationText }}</span>
    </span>
    <span
      class="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-muted/35 px-1.5 py-0.5 font-mono tabular-nums"
    >
      <HardDrive class="size-3 shrink-0" aria-hidden="true" />
      <span>{{ fmtBytes(totalBytes) }}</span>
    </span>
  </div>
</template>
