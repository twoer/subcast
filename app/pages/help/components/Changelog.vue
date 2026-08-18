<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Changelog tab: hand-curated list of versions with i18n-key bullets.
 * The CHANGELOG array is the source of truth here — keep newest first;
 * the matching translated copy lives under `help.changelog.v<NNN>.*`
 * in every locale.
 */
import { CalendarClock, ChevronRight, ExternalLink } from 'lucide-vue-next';
import { RELEASES_URL } from '../links';
import ChangelogEntry from './ChangelogEntry.vue';

const { t } = useI18n();

const CHANGELOG = [
  {
    version: '0.5.2',
    date: '2026-08-18',
    items: [
      'help.changelog.v052.fastFirst',
      'help.changelog.v052.runtimeStatus',
      'help.changelog.v052.taskClarity',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-08-16',
    items: [
      'help.changelog.v050.qwen3',
      'help.changelog.v050.sensevoice',
      'help.changelog.v050.polish',
      'help.changelog.v050.speed',
      'help.changelog.v050.stability',
    ],
  },
  {
    version: '0.4.8',
    date: '2026-06-22',
    items: [
      'help.changelog.v048.urlImport',
      'help.changelog.v048.cancel',
      'help.changelog.v048.stability',
    ],
  },
  {
    version: '0.4.1',
    date: '2026-06-19',
    items: [
      'help.changelog.v041.llamaStatic',
      'help.changelog.v041.foreignKey',
      'help.changelog.v041.windowsStartup',
      'help.changelog.v041.ciPipeline',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-05-18',
    items: [
      'help.changelog.v040.multiLocale',
      'help.changelog.v040.windowPause',
      'help.changelog.v040.playerToolbar',
      'help.changelog.v040.polish',
    ],
  },
  {
    version: '0.3.9',
    date: '2026-05-17',
    items: [
      'help.changelog.v039.batch',
      'help.changelog.v039.workflow',
      'help.changelog.v039.queue',
    ],
  },
  {
    version: '0.3.7',
    date: '2026-05-17',
    items: [
      'help.changelog.v037.diarize',
      'help.changelog.v037.speakerUi',
      'help.changelog.v037.packaging',
    ],
  },
  {
    version: '0.3.5',
    date: '2026-05-17',
    items: [
      'help.changelog.v035.downloads',
      'help.changelog.v035.mirrors',
      'help.changelog.v035.resume',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-05-16',
    items: [
      'help.changelog.v030.llama',
      'help.changelog.v030.localAi',
      'help.changelog.v030.settings',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-05-13',
    items: [
      'help.changelog.v020.macApp',
      'help.changelog.v020.packaging',
      'help.changelog.v020.diagnostics',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-05-09',
    items: [
      'help.changelog.v010.web',
      'help.changelog.v010.transcribe',
      'help.changelog.v010.translate',
    ],
  },
];

const recentEntries = CHANGELOG.slice(0, 2);
const olderEntries = CHANGELOG.slice(2);
</script>

<template>
  <section class="card space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarClock class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{{ t('help.changelog.title') }}</span>
        </h2>
        <p class="mt-2 text-sm leading-relaxed text-muted-foreground">{{ t('help.changelog.body') }}</p>
      </div>
      <a
        :href="RELEASES_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span>{{ t('help.changelog.allReleases') }}</span>
        <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      </a>
    </div>

    <ol class="space-y-5">
      <ChangelogEntry
        v-for="(entry, index) in recentEntries"
        :key="entry.version"
        :version="entry.version"
        :date="entry.date"
        :items="entry.items"
        :current="index === 0"
      />
    </ol>

    <details class="group border-t border-border/60 pt-4">
      <summary class="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted-foreground marker:hidden hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight class="size-4 shrink-0 transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
        <span>{{ t('help.changelog.olderVersions', { count: olderEntries.length }) }}</span>
      </summary>
      <ol class="mt-5 space-y-5">
        <ChangelogEntry
          v-for="entry in olderEntries"
          :key="entry.version"
          :version="entry.version"
          :date="entry.date"
          :items="entry.items"
        />
      </ol>
    </details>
  </section>
</template>
