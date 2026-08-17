<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';

interface Props {
  version: string;
  date: string;
  items: string[];
  current?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  current: false,
});

const { t, locale } = useI18n();

const primaryItems = computed(() => props.items.slice(0, 3));
const technicalItems = computed(() => props.items.slice(3));
const formattedDate = computed(() => new Intl.DateTimeFormat(locale.value, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
}).format(new Date(`${props.date}T00:00:00`)));
</script>

<template>
  <li class="border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3 class="font-mono text-sm font-semibold text-foreground">v{{ version }}</h3>
      <span
        v-if="current"
        class="rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-3xs font-semibold text-primary"
      >
        {{ t('help.changelog.current') }}
      </span>
      <time :datetime="date" class="font-mono text-xs text-muted-foreground">
        {{ formattedDate }}
      </time>
    </div>

    <ul class="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
      <li v-for="item in primaryItems" :key="item" class="flex items-start gap-2">
        <span aria-hidden="true" class="shrink-0 select-none text-muted-foreground">·</span>
        <span class="min-w-0">{{ t(item) }}</span>
      </li>
    </ul>

    <details v-if="technicalItems.length > 0" class="group mt-3">
      <summary class="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground marker:hidden hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight class="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
        <span>{{ t('help.changelog.technicalDetails') }}</span>
      </summary>
      <ul class="mt-2 space-y-2 text-sm leading-relaxed text-foreground">
        <li v-for="item in technicalItems" :key="item" class="flex items-start gap-2">
          <span aria-hidden="true" class="shrink-0 select-none text-muted-foreground">·</span>
          <span class="min-w-0">{{ t(item) }}</span>
        </li>
      </ul>
    </details>
  </li>
</template>
