/* SPDX-License-Identifier: Apache-2.0 */
import { ref, computed } from 'vue';
import { watchDebounced } from '@vueuse/core';

export interface SubtitleStyle {
  fontSize: number; // em
  color: string;
  bgOpacity: number; // 0..1
}

export const DEFAULT_STYLE: SubtitleStyle = {
  fontSize: 1.0,
  color: '#ffffff',
  bgOpacity: 0.6,
};

export const COLOR_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '#ffffff', label: 'White' },
  { value: '#facc15', label: 'Yellow' },
  { value: '#fb923c', label: 'Amber' },
  { value: '#22d3ee', label: 'Cyan' },
  { value: '#4ade80', label: 'Green' },
  { value: '#f472b6', label: 'Pink' },
  { value: '#000000', label: 'Black' },
];

const STORAGE_KEY = 'subcast.subtitleStyle';

/**
 * Owns the user's subtitle styling preference and persists it to
 * localStorage. Writes are debounced because slider drags and color-preset
 * clicks both trigger a burst of mutations.
 *
 * Call `load()` from `onMounted` so SSR-only environments don't touch
 * localStorage; the watch handler is no-op server-side as well.
 */
export function useSubtitleStyle() {
  const style = ref<SubtitleStyle>({ ...DEFAULT_STYLE });

  const isCustomColor = computed(
    () => !COLOR_PRESETS.some(
      (p) => p.value.toLowerCase() === style.value.color.toLowerCase(),
    ),
  );

  const cueFontSize = computed(() => `${style.value.fontSize}em`);
  const cueColor = computed(() => style.value.color);
  const cueBg = computed(() => `rgba(0, 0, 0, ${style.value.bgOpacity})`);

  function load(): void {
    if (!import.meta.client) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SubtitleStyle>;
        style.value = { ...DEFAULT_STYLE, ...parsed };
      }
    } catch {
      /* ignore — fall back to defaults */
    }
  }

  function save(): void {
    if (!import.meta.client) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(style.value));
    } catch {
      /* ignore quota */
    }
  }

  function reset(): void {
    style.value = { ...DEFAULT_STYLE };
  }

  watchDebounced(style, save, { deep: true, debounce: 300 });

  return {
    style,
    isCustomColor,
    cueFontSize,
    cueColor,
    cueBg,
    load,
    reset,
  };
}
