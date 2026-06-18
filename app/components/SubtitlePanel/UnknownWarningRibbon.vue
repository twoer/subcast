<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { AlertCircle } from 'lucide-vue-next';
import { computed } from 'vue';

/**
 * Top-of-panel warning when too much of the video is in the
 * 'unknown' bucket. Per docs/diarization-plan.md v1.5 R16, the
 * threshold is unknown_ratio >= 15%. The button is the primary
 * user-driven K-change entry point in both views (see "list view
 * change K" discussion in §五).
 */

const props = defineProps<{
  unknownDurationS: number;
  unknownRatio: number;
  currentTopK: number;
}>();

const emit = defineEmits<{
  retryWithMoreSpeakers: [topK: number];
}>();

const { t } = useI18n();

/** Suggest one more speaker. UI also shows "try K=N+1" as button text. */
const suggestedTopK = computed(() => Math.min(props.currentTopK + 1, 8));

const percentText = computed(() => `${Math.round(props.unknownRatio * 100)}%`);

const durationText = computed(() => {
  const total = Math.round(props.unknownDurationS);
  if (total < 60) return t('player.diarize.unknownDurationShort', { s: total });
  const m = Math.floor(total / 60);
  const s = total % 60;
  return t('player.diarize.unknownDurationLong', { m, s });
});

function suggest(): void {
  emit('retryWithMoreSpeakers', suggestedTopK.value);
}
</script>

<template>
  <div
    role="alert"
    class="flex items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
  >
    <AlertCircle class="h-4 w-4 shrink-0 text-warning" />
    <p class="flex-1 text-foreground/90 [word-break:keep-all]">
      <i18n-t keypath="player.diarize.unknownWarning" tag="span">
        <template #percent>
          <strong>{{ percentText }}</strong>
        </template>
        <template #duration>
          <strong>{{ durationText }}</strong>
        </template>
      </i18n-t>
    </p>
    <button
      type="button"
      class="inline-flex h-7 shrink-0 items-center rounded-md border border-warning/40 bg-warning/10 px-3 text-xs font-medium text-warning transition-colors hover:bg-warning/20"
      @click="suggest"
    >
      {{ t('player.diarize.tryMoreSpeakers', { k: suggestedTopK }) }}
    </button>
  </div>
</template>
