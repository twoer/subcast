<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Changelog tab: hand-curated list of versions with i18n-key bullets.
 * The CHANGELOG array is the source of truth here — keep newest first;
 * the matching translated copy lives under `help.changelog.v<NNN>.*`
 * in every locale.
 */
import { CalendarClock } from 'lucide-vue-next';

const { t } = useI18n();

const CHANGELOG = [
  {
    version: '0.4.6',
    date: '2026-06-22',
    items: [
      'help.changelog.v046.cancel',
      'help.changelog.v046.concurrency',
      'help.changelog.v046.realExt',
      'help.changelog.v046.ipv4',
    ],
  },
  {
    version: '0.4.5',
    date: '2026-06-21',
    items: [
      'help.changelog.v045.urlImport',
      'help.changelog.v045.dedup',
      'help.changelog.v045.network',
      'help.changelog.v045.schemaHeal',
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
</script>

<template>
  <section class="card space-y-5">
    <div>
      <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <CalendarClock class="h-3.5 w-3.5" />
        {{ t('help.changelog.title') }}
      </h2>
      <p class="mt-2 text-sm text-muted-foreground">{{ t('help.changelog.body') }}</p>
    </div>

    <ol class="space-y-5">
      <li
        v-for="entry in CHANGELOG"
        :key="entry.version"
        class="border-t border-border/60 pt-5 first:border-t-0 first:pt-0"
      >
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 class="font-mono text-sm font-semibold text-foreground">v{{ entry.version }}</h3>
          <time class="font-mono text-xs text-muted-foreground">{{ entry.date }}</time>
        </div>
        <ul class="mt-2 space-y-1.5 text-sm text-foreground">
          <li
            v-for="item in entry.items"
            :key="item"
            class="flex items-baseline gap-2"
          >
            <span aria-hidden="true" class="select-none">·</span>
            <span>{{ t(item) }}</span>
          </li>
        </ul>
      </li>
    </ol>
  </section>
</template>
