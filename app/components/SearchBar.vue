<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { refDebounced } from '@vueuse/core';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';

interface CueLike { text: string }

const props = defineProps<{
  cues: CueLike[];
}>();

const emit = defineEmits<{
  (e: 'update:query', value: string): void;
  (e: 'update:matchIdx', value: number | null): void;
}>();

const { t } = useI18n();

const query = ref('');
const debouncedQuery = refDebounced(query, 80);
const cursor = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const matches = computed<number[]>(() => {
  const q = debouncedQuery.value.trim().toLowerCase();
  if (!q) return [];
  return props.cues
    .map((c, i) => (c.text.toLowerCase().includes(q) ? i : -1))
    .filter((i) => i >= 0);
});

watch(debouncedQuery, (v) => {
  emit('update:query', v);
  cursor.value = 0;
});

watch(matches, (m) => {
  emit('update:matchIdx', m.length === 0 ? null : m[cursor.value % m.length]!);
});

function next() {
  if (matches.value.length === 0) return;
  cursor.value = (cursor.value + 1) % matches.value.length;
  emit('update:matchIdx', matches.value[cursor.value]!);
}

function prev() {
  if (matches.value.length === 0) return;
  cursor.value = (cursor.value - 1 + matches.value.length) % matches.value.length;
  emit('update:matchIdx', matches.value[cursor.value]!);
}

function focus() {
  inputRef.value?.focus();
}

function clear() {
  query.value = '';
  cursor.value = 0;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clear();
    inputRef.value?.blur();
  }
}

defineExpose({ focus, clear });
</script>

<template>
  <div class="flex w-full items-center gap-1.5 rounded-xl border border-border/60 bg-background px-2 py-1">
    <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    <input
      ref="inputRef"
      v-model="query"
      type="text"
      :placeholder="t('player.search.placeholder')"
      class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
      @keydown="onKey"
    >
    <span class="shrink-0 tabular-nums text-xs text-muted-foreground">
      {{ matches.length === 0 ? '0/0' : `${(cursor % matches.length) + 1}/${matches.length}` }}
    </span>
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
          :disabled="matches.length === 0"
          :aria-label="t('player.search.prev')"
          @click="prev"
        ><ChevronUp class="h-3.5 w-3.5" /></button>
      </TooltipTrigger>
      <TooltipContent>{{ t('player.search.prev') }}</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
          :disabled="matches.length === 0"
          :aria-label="t('player.search.next')"
          @click="next"
        ><ChevronDown class="h-3.5 w-3.5" /></button>
      </TooltipTrigger>
      <TooltipContent>{{ t('player.search.next') }}</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
          :disabled="query.length === 0"
          :aria-label="t('player.search.clear')"
          @click="clear"
        ><X class="h-3.5 w-3.5" /></button>
      </TooltipTrigger>
      <TooltipContent>{{ t('player.search.clear') }}</TooltipContent>
    </Tooltip>
  </div>
</template>
