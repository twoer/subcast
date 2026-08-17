<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * About tab: app identity card, dependency list, external link buttons.
 * Falls back to the package version string when desktop.appVersion is
 * unavailable (web build / pre-mount).
 */
import { ChevronRight, ExternalLink, PackageOpen } from 'lucide-vue-next';
import { resolveAppVersion } from '~/utils/appVersion';
import { REPO_URL, DOCS_URL, ISSUES_URL, LICENSE_URL } from '../links';

const { t } = useI18n();
const desktop = useDesktop();
const config = useRuntimeConfig();

const appVersion = computed(() => resolveAppVersion(
  desktop.appVersion,
  config.public.appVersion,
));

const aboutDependencies: Array<{ name: string; version: string; license: string }> = [
  { name: 'SenseVoice', version: 'Small · int8', license: 'Model License' },
  { name: 'Whisper.cpp', version: 'v1.8.4', license: 'MIT' },
  { name: 'Qwen3', version: '4B – 14B · GGUF', license: 'Apache-2.0' },
  { name: 'llama.cpp', version: 'b10435', license: 'MIT' },
  { name: 'Diarization: pyannote · 3D-Speaker', version: 'via sherpa-onnx', license: 'MIT / Apache-2.0' },
  { name: 'FFmpeg', version: 'LGPL build', license: 'LGPL' },
  { name: 'Silero VAD', version: 'v4.0', license: 'MIT' },
  { name: 'ONNX Runtime', version: 'v1.26', license: 'MIT' },
  { name: 'Electron', version: 'v36.x', license: 'MIT' },
  { name: 'Nuxt 4 · Vue 3', version: 'latest', license: 'MIT' },
];
</script>

<template>
  <section class="space-y-4">
    <div class="card">
      <div class="flex items-start gap-4">
        <img src="/favicon.svg" alt="Subcast" class="size-16 shrink-0 rounded-xl shadow-sm ring-1 ring-border/60">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-2xl font-semibold tracking-tight">Subcast</h2>
            <span class="rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
              v{{ appVersion }}
            </span>
          </div>
          <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            {{ t('desktop.about.subtitle') }}
          </p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <span class="inline-flex items-center rounded-md border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
              {{ t('desktop.about.fullyLocal') }}
            </span>
            <a
              :href="LICENSE_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>Apache-2.0</span>
              <ExternalLink class="size-3 shrink-0" aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>

      <div class="mt-5 flex flex-wrap gap-2 border-t border-border/60 pt-4">
        <a
          :href="DOCS_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          <span>{{ t('desktop.about.buttons.documentation') }}</span>
        </a>
        <a
          :href="REPO_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          <span>{{ t('desktop.about.buttons.repository') }}</span>
        </a>
        <a
          :href="ISSUES_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <ExternalLink class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
          <span>{{ t('desktop.about.buttons.reportIssue') }}</span>
        </a>
      </div>
    </div>

    <details class="card group">
      <summary class="flex cursor-pointer list-none items-center gap-2 marker:hidden [&::-webkit-details-marker]:hidden">
        <PackageOpen class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {{ t('desktop.about.depsHeader') }}
        </span>
        <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
      </summary>
      <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
        {{ t('desktop.about.dependenciesHint') }}
      </p>
      <ul class="mt-4 grid gap-2 sm:grid-cols-2">
        <li
          v-for="d in aboutDependencies"
          :key="d.name"
          class="flex items-start justify-between gap-3 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
        >
          <span class="min-w-0">
            <span class="block break-words text-sm font-medium text-foreground">{{ d.name }}</span>
            <span class="block break-words font-mono text-xs text-muted-foreground">{{ d.version }}</span>
          </span>
          <span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            {{ d.license }}
          </span>
        </li>
      </ul>
    </details>

    <p class="text-xs text-muted-foreground">{{ t('desktop.about.licenseLine') }} Apache-2.0</p>
  </section>
</template>
