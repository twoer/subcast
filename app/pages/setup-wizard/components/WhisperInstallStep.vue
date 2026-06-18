<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, CheckCircle2, Link2, Loader2, X as XIcon } from 'lucide-vue-next';
import { Button } from '~/components/ui/button';
import { Progress } from '~/components/ui/progress';
import { Badge } from '~/components/ui/badge';
import type { WhisperInstallSnapshot } from '#shared/installContracts';
import type {
  ScanAction,
  ScannedModel,
  SetupStatus,
  WhisperMirror,
  WhisperModelName,
} from '@/types/setupWizard';

const props = defineProps<{
  models: Array<{ id: WhisperModelName; sizeLabel: string }>;
  status: SetupStatus;
  selectedModel: WhisperModelName;
  scanAction: ScanAction;
  mirror: WhisperMirror;
  scannedMatch: ScannedModel | null;
  installedMatch: ScannedModel | null;
  task: WhisperInstallSnapshot | null;
  taskOwnsSelection: boolean;
  installRunning: boolean;
  installFinished: boolean;
  installFailed: boolean;
  installCanceled: boolean;
  progressPercent: number;
  actionError: string | null;
  statusForModel: (name: WhisperModelName) => 'installed' | 'available' | 'missing';
  externalSource: (name: WhisperModelName) => string | null;
  formatProgressBytes: (n: number | null) => string;
  formatEta: (s: number | null) => string;
}>();

const emit = defineEmits<{
  'update:selectedModel': [value: WhisperModelName];
  'update:scanAction': [value: ScanAction];
  'update:mirror': [value: WhisperMirror];
  cancel: [];
}>();

const { t } = useI18n();

const selectedModelProxy = computed({
  get: () => props.selectedModel,
  set: (value: WhisperModelName) => emit('update:selectedModel', value),
});
const scanActionProxy = computed({
  get: () => props.scanAction,
  set: (value: ScanAction) => emit('update:scanAction', value),
});
const mirrorProxy = computed({
  get: () => props.mirror,
  set: (value: WhisperMirror) => emit('update:mirror', value),
});
</script>

<template>
  <div class="space-y-3">
  <section class="space-y-3">
    <div
      v-for="m in models"
      :key="m.id"
      class="card-compact transition-colors"
      :class="selectedModel === m.id ? 'border-primary/50 bg-accent/30' : 'hover:bg-accent/20'"
    >
      <label class="flex cursor-pointer items-center gap-3">
        <input
          v-model="selectedModelProxy"
          type="radio"
          :value="m.id"
          :disabled="installRunning"
          class="h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
        <span class="font-medium">ggml-{{ m.id }}.bin</span>
        <Badge v-if="status.recommendedWhisperModel === m.id" variant="secondary">{{ t('desktop.setupWizard.recommended') }}</Badge>
        <span
          v-if="statusForModel(m.id) === 'installed'"
          class="inline-flex items-center gap-1 text-xs text-success"
        >
          <CheckCircle2 class="h-3.5 w-3.5" />
          {{ t('desktop.llm.alreadyInstalled') }}
        </span>
        <span
          v-else-if="statusForModel(m.id) === 'available'"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Link2 class="h-3.5 w-3.5" />
          {{ externalSource(m.id) }}
        </span>
        <span class="ml-auto text-sm text-muted-foreground">{{ m.sizeLabel }}</span>
      </label>

      <div
        v-if="selectedModel === m.id && scannedMatch && !installedMatch"
        class="mt-4 space-y-3 border-t border-border pt-3 pl-7"
      >
        <p class="flex items-start gap-1.5 text-sm text-success">
          <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {{ t('desktop.setupWizard.foundAt') }}
            <span class="font-mono text-xs">{{ scannedMatch.path }}</span>
            <span class="text-muted-foreground"> ({{ scannedMatch.source }})</span>
          </span>
        </p>
        <div class="space-y-2 text-sm">
          <label class="flex cursor-pointer items-center gap-2">
            <input
              v-model="scanActionProxy"
              type="radio"
              value="symlink"
              :disabled="installRunning"
              class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
            <span>{{ t('desktop.setupWizard.actionSymlink') }}</span>
          </label>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              v-model="scanActionProxy"
              type="radio"
              value="copy"
              :disabled="installRunning"
              class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
            <span>{{ t('desktop.setupWizard.actionCopy') }}</span>
          </label>
          <label class="flex cursor-pointer items-center gap-2">
            <input
              v-model="scanActionProxy"
              type="radio"
              value="ignore"
              :disabled="installRunning"
              class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
            <span>{{ t('desktop.setupWizard.actionIgnore') }}</span>
          </label>
        </div>
      </div>
    </div>
  </section>

  <section
    v-if="!scannedMatch || scanAction === 'ignore'"
    class="rounded-md border border-border/60 bg-muted/30 p-3"
  >
    <label class="flex cursor-pointer items-center gap-3 text-sm">
      <input
        v-model="mirrorProxy"
        type="checkbox"
        :true-value="'hf-mirror'"
        :false-value="'auto'"
        :disabled="installRunning"
        class="size-4 accent-primary"
      >
      <i18n-t keypath="desktop.setupWizard.mirrorToggle" tag="span">
        <template #host><code class="font-mono">hf-mirror.com</code></template>
      </i18n-t>
    </label>
    <p v-if="mirror === 'auto'" class="mt-2 text-xs text-muted-foreground">
      {{ $t('desktop.setupWizard.mirrorAutoNote') }}
    </p>
  </section>

  <section
    v-if="task && taskOwnsSelection && installRunning"
    class="surface-1 space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-4"
  >
    <div class="flex items-center justify-between gap-3">
      <p class="flex items-center gap-2 text-sm font-medium">
        <Loader2 class="h-4 w-4 animate-spin text-primary" />
        <span>
          {{ task.kind === 'download'
            ? t('desktop.setupWizard.downloading')
            : task.kind === 'symlink'
              ? t('desktop.setupWizard.linking')
              : t('desktop.setupWizard.copying') }}
          <span class="font-mono">ggml-{{ task.model }}.bin</span>
        </span>
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
    v-if="installFinished && task"
    class="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
  >
    <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
    <span>
      {{ t('desktop.setupWizard.installedAt', { name: `ggml-${task.model}.bin` }) }}
      <span class="font-mono text-xs">{{ task.destPath }}</span>
    </span>
  </section>

  <section
    v-if="installFailed && task"
    class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
  >
    <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
    <span>{{ t('desktop.setupWizard.installFailed', { error: task.error }) }}</span>
  </section>

  <section
    v-if="installCanceled"
    class="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
  >
    <span>{{ t('desktop.setupWizard.installCanceled') }}</span>
  </section>

  <div v-if="actionError" class="text-sm text-destructive">{{ actionError }}</div>
  </div>
</template>
