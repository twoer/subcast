<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { List, Users } from 'lucide-vue-next';

/**
 * Subtitle view toggle button (Q9, docs/diarization-plan.md v1.5).
 *
 * Segmented control with two visual states. The "grouped" button is
 * the icon + current K number (R15: count goes into the button, no
 * separate K selector exists). Pure presentational — parent owns the
 * model + the smart-default logic via useSubtitleView.
 *
 * Hidden entirely when there's nothing to toggle (K=1 or no diarize),
 * which the parent controls via v-if on `toggleVisible`.
 */

defineProps<{
  /** Current effective view, drives the active highlight. */
  modelValue: 'list' | 'grouped';
  /** Speaker count displayed inside the grouped button. */
  speakerCount: number;
}>();

defineEmits<{
  'update:modelValue': [value: 'list' | 'grouped'];
}>();

const { t } = useI18n();
</script>

<template>
  <!-- Visual sibling of <SearchBar>: same rounded-xl + border-border/60
       + bg-background pill, so the two controls in the panel header
       read as a matched pair. Buttons inside are flat (no own border);
       the active state is a filled accent. -->
  <div
    role="group"
    :aria-label="t('player.diarize.viewToggle.aria')"
    class="inline-flex shrink-0 items-center gap-0.5 rounded-xl border border-border/60 bg-background p-0.5"
  >
    <button
      type="button"
      :class="[
        'inline-flex items-center justify-center rounded-lg px-2 py-1.5 transition',
        modelValue === 'list'
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      ]"
      :aria-pressed="modelValue === 'list'"
      :title="t('player.diarize.viewToggle.list')"
      @click="$emit('update:modelValue', 'list')"
    >
      <List class="h-3.5 w-3.5" />
    </button>
    <button
      type="button"
      :class="[
        'inline-flex items-center gap-1 rounded-lg px-2 py-1.5 transition',
        modelValue === 'grouped'
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      ]"
      :aria-pressed="modelValue === 'grouped'"
      :title="t('player.diarize.viewToggle.grouped')"
      @click="$emit('update:modelValue', 'grouped')"
    >
      <Users class="h-3.5 w-3.5" />
      <span class="text-2xs font-semibold tabular-nums">{{ speakerCount }}</span>
    </button>
  </div>
</template>
