<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Help tab: diagnostics export, log viewer, update notes, FAQ, external links.
 * Fully self-contained — owns its own FAQ list and diagnostic download.
 */
import {
  BookOpen, ChevronRight, Download, ExternalLink, RefreshCw, Wrench,
} from 'lucide-vue-next';
import { REPO_URL, DOCS_URL, ISSUES_URL } from '../links';

interface FaqItem {
  titleKey: string;
  bodyKey: string;
}

const { t } = useI18n();
const desktop = useDesktop();

const FAQ: FaqItem[] = [
  { titleKey: 'desktop.help.faq.mirrorTitle', bodyKey: 'desktop.help.faq.mirrorBody' },
  { titleKey: 'desktop.help.faq.macGatekeeperTitle', bodyKey: 'desktop.help.faq.macGatekeeperBody' },
  { titleKey: 'desktop.help.faq.zombieTitle', bodyKey: 'desktop.help.faq.zombieBody' },
];

function downloadDiagnostic(): void {
  window.location.href = '/api/diagnostic';
}
</script>

<template>
  <div class="space-y-6">
    <p class="text-sm text-muted-foreground">{{ t('desktop.help.introBody') }}</p>

    <section class="card">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Download class="h-3.5 w-3.5" />
            {{ t('desktop.help.diagnostics.title') }}
          </h2>
          <p class="mt-2 text-sm text-foreground">{{ t('desktop.help.diagnostics.body') }}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          class="shrink-0 whitespace-nowrap"
          @click="downloadDiagnostic"
        >
          <Download class="h-4 w-4" />
          {{ t('desktop.help.diagnostics.export') }}
        </Button>
      </div>
    </section>

    <LogViewer v-if="desktop.isDesktop" />

    <section class="card">
      <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <RefreshCw class="h-3.5 w-3.5" />
        {{ t('desktop.help.updates.title') }}
      </h2>
      <ul class="space-y-2 text-sm text-foreground">
        <li class="flex items-baseline gap-2">
          <span aria-hidden="true" class="select-none">·</span>
          <span>{{ t('desktop.help.updates.windowsBody') }}</span>
        </li>
        <li class="flex items-baseline gap-2">
          <span aria-hidden="true" class="select-none">·</span>
          <span>{{ t('desktop.help.updates.macBody') }}</span>
        </li>
      </ul>
    </section>

    <section class="card">
      <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Wrench class="h-3.5 w-3.5" />
        {{ t('desktop.help.faq.title') }}
      </h2>
      <div class="space-y-2">
        <details
          v-for="item in FAQ"
          :key="item.titleKey"
          class="group rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
        >
          <summary class="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground marker:hidden [&::-webkit-details-marker]:hidden">
            <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90" />
            <span class="flex-1">{{ t(item.titleKey) }}</span>
          </summary>
          <p class="mt-2 pl-6 text-muted-foreground">{{ t(item.bodyKey) }}</p>
        </details>
      </div>
    </section>

    <section class="card">
      <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <BookOpen class="h-3.5 w-3.5" />
        {{ t('desktop.help.links.docs') }}
      </h2>
      <div class="flex flex-wrap gap-2">
        <a
          :href="DOCS_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink class="h-3 w-3 opacity-70" />
          {{ t('desktop.help.links.docs') }}
        </a>
        <a
          :href="REPO_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink class="h-3 w-3 opacity-70" />
          {{ t('desktop.help.links.repository') }}
        </a>
        <a
          :href="ISSUES_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink class="h-3 w-3 opacity-70" />
          {{ t('desktop.help.links.reportIssue') }}
        </a>
      </div>
    </section>
  </div>
</template>
