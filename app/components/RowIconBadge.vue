<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { Film, AudioLines, Captions, Languages, Sparkles, UsersRound } from 'lucide-vue-next';

/**
 * Unified 36×36 leading icon block used across all three home-page lists
 * (recent / queue / library) so each row gets the same visual anchor
 * regardless of section. The inner glyph + tint switches by content:
 *
 *   - media rows (recent / library) — Film for video, AudioLines for
 *     audio, distinguished by `ext`.
 *   - queue rows — Captions / Languages / Sparkles by task kind, plus
 *     a per-kind tint (blue / cyan / violet) so the queue is scannable
 *     at a glance.
 *
 * Tints use raw Tailwind colors for translate / insight because the
 * design system has no `info` / `accent-purple` tokens yet; if those
 * get added later, swap the bg/text classes here.
 */

type MediaKind = { kind: 'media'; ext?: string };
type TaskKind = { kind: 'transcribe' | 'translate' | 'insight' | 'diarize' };

const props = defineProps<MediaKind | TaskKind>();

const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);

const config = computed(() => {
  if (props.kind === 'media') {
    const ext = (props.ext ?? '').toLowerCase().replace(/^\./, '');
    const isAudio = AUDIO_EXTS.has(ext);
    return {
      icon: isAudio ? AudioLines : Film,
      tint: 'bg-primary/10 text-primary',
    };
  }
  if (props.kind === 'transcribe') {
    return { icon: Captions, tint: 'bg-primary/10 text-primary' };
  }
  if (props.kind === 'translate') {
    return {
      icon: Languages,
      tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    };
  }
  if (props.kind === 'diarize') {
    return {
      icon: UsersRound,
      tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    };
  }
  // insight
  return {
    icon: Sparkles,
    tint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  };
});
</script>

<template>
  <div
    class="grid h-9 w-9 shrink-0 place-items-center rounded-md"
    :class="config.tint"
  >
    <component :is="config.icon" class="h-4 w-4" />
  </div>
</template>
