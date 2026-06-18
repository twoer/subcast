<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import type { SpeakerId } from '#shared/diarization';

/**
 * Small inline speaker chip (color dot + letter) shown on each row in
 * list view. Click is intentionally a no-op for v1 — users rename via
 * the grouped view's block header ⋯ menu (Q9d). Doing both is feature
 * creep + would confuse the v1.5 R15 design where the toggle button
 * is the only count display.
 *
 * Color comes from a stable HSL ring computed by parent (parent passes
 * `colorIndex` derived from `speakerColorIndex` in shared/diarization
 * so it doesn't jump after merges / K changes).
 */

const props = defineProps<{
  speakerId: SpeakerId;
  colorIndex: number;
  /** Optional display name from speakers.display_name. Falls back to short letter (A/B/…). */
  displayName: string | null;
}>();

const { t } = useI18n();

const isUnknown = computed(() => props.speakerId === 'unknown');

/**
 * Single-glyph chip label. Priority: rename → displayName's first char
 * (keeps the list view in sync with the grouped block header, which
 * already shows the renamed full name); fallback → "A"/"B" from the
 * semantic speaker_A id.
 */
const shortLabel = computed(() => {
  if (isUnknown.value) return '?';
  const renamed = props.displayName?.trim().charAt(0);
  if (renamed) return renamed.toUpperCase();
  const m = props.speakerId.match(/^speaker_([A-Z]{1,2})$/);
  return m ? m[1] : props.speakerId.slice(0, 2).toUpperCase();
});

/** Long label used as title attribute (tooltip). */
const longLabel = computed(() => {
  if (isUnknown.value) return t('player.diarize.unknownSpeaker');
  return props.displayName || t('player.diarize.speakerDefault', { letter: shortLabel.value });
});

/** Stable hue. golden-angle * colorIndex gives well-spread hues. */
const hslHue = computed(() => {
  if (isUnknown.value) return null;
  return (props.colorIndex * 137) % 360;
});

const chipStyle = computed(() => {
  if (isUnknown.value) {
    return {
      backgroundColor: 'hsl(215 16% 60% / 0.12)',
      color: 'hsl(215 16% 45%)',
    };
  }
  return {
    backgroundColor: `hsl(${hslHue.value} 75% 55% / 0.12)`,
    color: `hsl(${hslHue.value} 75% 35%)`,
  };
});
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-2xs font-semibold"
    :class="isUnknown ? 'border border-dashed border-current/40 opacity-75' : ''"
    :style="chipStyle"
    :title="longLabel"
  >
    {{ shortLabel }}
  </span>
</template>
