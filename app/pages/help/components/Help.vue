<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Help tab: diagnostics export, log viewer, update notes, FAQ, external links.
 * Fully self-contained — owns its own FAQ list and diagnostic download.
 */
import {
  BookOpen, Bug, ChevronRight, Download, ExternalLink, RefreshCw, Wrench,
} from 'lucide-vue-next';
import { resolveAppVersion } from '~/utils/appVersion';
import { REPO_URL, DOCS_URL, ISSUES_URL, RELEASES_URL } from '../links';

interface FaqItem {
  titleKey: string;
  bodyKey: string;
}

const { t } = useI18n();
const desktop = useDesktop();
const config = useRuntimeConfig();

const appVersion = computed(() => resolveAppVersion(
  desktop.appVersion,
  config.public.appVersion,
));

const updateDescription = computed(() => {
  if (desktop.platform === 'win32') return t('desktop.help.updates.windowsBody');
  if (desktop.platform === 'darwin') return t('desktop.help.updates.macBody');
  return t('desktop.help.updates.webBody');
});

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
    <section aria-labelledby="help-quick-actions">
      <div class="mb-4">
        <h2 id="help-quick-actions" class="text-sm font-semibold text-foreground">
          {{ t('desktop.help.quickActions.title') }}
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
          {{ t('desktop.help.introBody') }}
        </p>
      </div>

      <div class="grid gap-2 sm:grid-cols-2">
        <a
          :href="DOCS_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center justify-between gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <span class="inline-flex min-w-0 items-center gap-2">
            <BookOpen class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0">{{ t('desktop.help.quickActions.documentation') }}</span>
          </span>
          <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        </a>
        <a
          :href="RELEASES_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center justify-between gap-2 rounded-md border border-input bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <span class="inline-flex min-w-0 items-center gap-2">
            <RefreshCw class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0">{{ t('desktop.help.quickActions.latestRelease') }}</span>
          </span>
          <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        </a>
        <button
          type="button"
          class="inline-flex min-h-11 items-center gap-2 rounded-md border border-input bg-background px-4 py-2.5 text-start text-sm font-medium text-foreground transition-colors hover:bg-accent"
          @click="downloadDiagnostic"
        >
          <Download class="size-4 shrink-0" aria-hidden="true" />
          <span class="min-w-0">{{ t('desktop.help.quickActions.exportDiagnostics') }}</span>
        </button>
        <a
          :href="ISSUES_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center justify-between gap-2 rounded-md border border-input bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <span class="inline-flex min-w-0 items-center gap-2">
            <Bug class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0">{{ t('desktop.help.quickActions.reportIssue') }}</span>
          </span>
          <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        </a>
      </div>
    </section>

    <section class="card">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-foreground">
          <RefreshCw class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{{ t('desktop.help.updates.title') }}</span>
        </h2>
        <span class="rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
          v{{ appVersion }}
        </span>
      </div>
      <p class="mt-3 text-sm leading-relaxed text-muted-foreground">
        {{ updateDescription }}
      </p>
    </section>

    <section class="card">
      <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Wrench class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>{{ t('desktop.help.faq.title') }}</span>
      </h2>
      <div class="space-y-2">
        <details
          v-for="item in FAQ"
          :key="item.titleKey"
          class="group rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
        >
          <summary class="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground marker:hidden [&::-webkit-details-marker]:hidden">
            <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
            <span class="min-w-0 flex-1">{{ t(item.titleKey) }}</span>
          </summary>
          <p class="mt-2 ps-6 leading-relaxed text-muted-foreground">{{ t(item.bodyKey) }}</p>
        </details>
      </div>
    </section>

    <details v-if="desktop.isDesktop" class="card group">
      <summary class="flex cursor-pointer list-none items-center gap-2 marker:hidden [&::-webkit-details-marker]:hidden">
        <Wrench class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {{ t('desktop.help.advanced.title') }}
        </span>
        <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div class="mt-4 space-y-4 border-t border-border/60 pt-4">
        <p class="text-sm leading-relaxed text-muted-foreground">
          {{ t('desktop.help.diagnostics.body') }}
        </p>
        <LogViewer />
      </div>
    </details>

    <footer class="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4 text-xs text-muted-foreground">
      <span>{{ t('desktop.help.links.project') }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <a
          :href="REPO_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-foreground underline decoration-border underline-offset-4 hover:text-primary"
        >
          <span>{{ t('desktop.help.links.repository') }}</span>
          <ExternalLink class="size-3 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </footer>
  </div>
</template>
