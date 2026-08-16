<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Step-1 alternate engine card: SenseVoice (zh/en/ja/ko/yue, fast CPU
 * path). Single fixed model, download-only — no tier cards, no symlink
 * / copy picker, no mirror toggle (single GitHub source). The download
 * / next buttons live in the shared footer, same as the Whisper step.
 */
import { CheckCircle2, AlertCircle, Loader2, X as XIcon } from 'lucide-vue-next';
import { Button } from '~/components/ui/button';
import { Progress } from '~/components/ui/progress';
import type { SenseVoiceInstallSnapshot } from '#shared/installContracts';
defineProps<{
  ready: boolean;
  task: SenseVoiceInstallSnapshot | null;
  running: boolean;
  finished: boolean;
  failed: boolean;
  canceled: boolean;
  progressPercent: number;
  actionError: string | null;
  formatProgressBytes: (n: number | null) => string;
  formatEta: (s: number | null) => string;
}>();

const emit = defineEmits<{
  cancel: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="space-y-4">
    <section class="rounded-md border border-border/60 bg-muted/30 p-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-sm font-medium">SenseVoice-Small (int8)</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ t('desktop.setupWizard.svModelMeta') }}
          </p>
        </div>
        <span
          v-if="ready"
          class="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-3xs font-medium uppercase tracking-wider text-success"
        >
          <CheckCircle2 class="h-3 w-3" />
          {{ t('desktop.setupWizard.installed') }}
        </span>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">
        {{ ready ? t('desktop.setupWizard.svReadyHint') : t('desktop.setupWizard.svNotInstalledHint') }}
      </p>
    </section>

    <section
      v-if="task && running"
      class="surface-1 space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-4"
    >
      <div class="flex items-center justify-between gap-3">
        <p class="flex items-center gap-2 text-sm font-medium">
          <Loader2 class="h-4 w-4 animate-spin text-primary" />
          <span>{{ t('desktop.setupWizard.downloading') }} SenseVoice-Small</span>
        </p>
        <span class="font-mono text-xs tabular-nums text-muted-foreground">
          {{ progressPercent }}%
        </span>
      </div>
      <Progress :model-value="progressPercent" />
      <div class="flex items-center justify-between gap-3">
        <p v-if="task.progress" class="font-mono text-xs tabular-nums text-muted-foreground">
          {{ formatProgressBytes(task.progress.bytesDownloaded) }} /
          {{ formatProgressBytes(task.progress.bytesTotal) }} ·
          {{ formatProgressBytes(Math.round(task.progress.bytesPerSecond)) }}{{ t('desktop.setupWizard.perSecond') }} ·
          {{ formatEta(task.progress.etaSeconds) }}
        </p>
        <span v-else />
        <Button variant="outline" size="sm" class="shrink-0" @click="emit('cancel')">
          <XIcon class="h-3.5 w-3.5" />
          {{ t('desktop.setupWizard.cancel') }}
        </Button>
      </div>
    </section>

    <section
      v-if="finished && task"
      class="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
    >
      <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ t('desktop.setupWizard.installedAt', { name: 'SenseVoice-Small (int8)' }) }}</span>
    </section>

    <section
      v-if="failed && task"
      class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ t('desktop.setupWizard.installFailed', { error: task.error }) }}</span>
    </section>

    <section
      v-if="canceled"
      class="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
    >
      <span>{{ t('desktop.setupWizard.installCanceled') }}</span>
    </section>

    <div v-if="actionError" class="text-sm text-destructive">{{ actionError }}</div>
  </div>
</template>
