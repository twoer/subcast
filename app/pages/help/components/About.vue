<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * About tab: app identity card, dependency list, external link buttons.
 * Falls back to the package version string when desktop.appVersion is
 * unavailable (web build / pre-mount).
 */
import { ExternalLink } from 'lucide-vue-next';
import { REPO_URL, ISSUES_URL, LICENSE_URL } from '../links';

const { t } = useI18n();
const desktop = useDesktop();

const appVersion = computed<string>(() => desktop.appVersion ?? '0.4.0');

const aboutDependencies: Array<{ name: string; version: string; license: string }> = [
  { name: 'Whisper.cpp', version: 'v1.8.4', license: 'MIT' },
  { name: 'llama.cpp', version: 'bundled', license: 'MIT' },
  { name: 'FFmpeg', version: 'LGPL build', license: 'LGPL' },
  { name: 'Silero VAD', version: 'v4.0', license: 'MIT' },
  { name: 'ONNX Runtime', version: 'v1.26', license: 'MIT' },
  { name: 'Electron', version: 'v36.x', license: 'MIT' },
  { name: 'Nuxt 4 · Vue 3', version: 'latest', license: 'MIT' },
];
</script>

<template>
  <section class="space-y-4">
    <div class="card overflow-hidden p-0">
      <div class="grid gap-0 md:grid-cols-[1.15fr,0.85fr]">
        <div class="flex items-start gap-4 border-b border-border/60 p-6 md:border-b-0 md:border-r">
          <img src="/favicon.svg" alt="Subcast" class="h-16 w-16 shrink-0 rounded-xl shadow-sm ring-1 ring-border/60">
          <div class="min-w-0">
            <h2 class="text-2xl font-semibold tracking-tight">Subcast</h2>
            <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
              {{ t('desktop.about.subtitle') }}
            </p>
            <div class="mt-4 flex flex-wrap gap-2">
              <span class="inline-flex items-center rounded-md border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                {{ t('desktop.about.fullyLocal') }}
              </span>
              <span class="inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 font-mono text-xs text-muted-foreground">
                v{{ appVersion }}
              </span>
            </div>
          </div>
        </div>

        <div class="grid content-start gap-3 p-6">
          <div class="rounded-md border border-border/60 bg-muted/25 p-3">
            <div class="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('desktop.about.versionLabel') }}
            </div>
            <div class="mt-1 font-mono text-sm text-foreground">v{{ appVersion }}</div>
          </div>
          <div class="rounded-md border border-border/60 bg-muted/25 p-3">
            <div class="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('desktop.about.privacyLabel') }}
            </div>
            <div class="mt-1 text-sm text-foreground">{{ t('desktop.about.fullyLocal') }}</div>
          </div>
          <div class="rounded-md border border-border/60 bg-muted/25 p-3">
            <div class="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('desktop.about.licenseLabel') }}
            </div>
            <div class="mt-1 text-sm text-foreground">Apache-2.0</div>
          </div>
        </div>
      </div>
    </div>

    <section class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('desktop.about.depsHeader') }}
        </h3>
        <p class="text-xs text-muted-foreground">
          {{ t('desktop.about.licenseLine') }}
          <a
            :href="LICENSE_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="underline decoration-border hover:text-foreground"
          >Apache-2.0</a>
        </p>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2">
        <li
          v-for="d in aboutDependencies"
          :key="d.name"
          class="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
        >
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium text-foreground">{{ d.name }}</span>
            <span class="block truncate font-mono text-xs text-muted-foreground">{{ d.version }}</span>
          </span>
          <span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            {{ d.license }}
          </span>
        </li>
      </ul>
    </section>

    <div class="flex flex-wrap gap-2">
      <a
        :href="REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <ExternalLink class="h-3 w-3 opacity-70" />
        {{ t('desktop.about.buttons.repository') }}
      </a>
      <a
        :href="LICENSE_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <ExternalLink class="h-3 w-3 opacity-70" />
        {{ t('desktop.about.buttons.license') }}
      </a>
      <a
        :href="ISSUES_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <ExternalLink class="h-3 w-3 opacity-70" />
        {{ t('desktop.about.buttons.reportIssue') }}
      </a>
    </div>
  </section>
</template>
