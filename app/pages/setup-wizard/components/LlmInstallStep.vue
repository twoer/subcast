<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircle, CheckCircle2, Link2, Loader2, X as XIcon } from 'lucide-vue-next';
import { Button } from '~/components/ui/button';
import { Progress } from '~/components/ui/progress';
import { Badge } from '~/components/ui/badge';
import { LLM_MODELS, type LlmMirror, type LlmModelId } from '#shared/llmModels';
import { fmtBytes } from '~/utils/format';
import type { LlmInstallSnapshot } from '#shared/installContracts';
import type {
  LlmScannedHit,
  LlmStatusResp,
  ScanAction,
} from '@/types/setupWizard';

const props = defineProps<{
  tiers: ReadonlyArray<{ id: LlmModelId }>;
  llmStatus: LlmStatusResp;
  selectedLlm: LlmModelId;
  llmMirror: LlmMirror;
  llmScanAction: ScanAction;
  installedLlmIds: Set<LlmModelId>;
  lowMemoryWarning: boolean;
  llmTask: LlmInstallSnapshot | null;
  llmTaskOwnsSelection: boolean;
  llmInstallRunning: boolean;
  llmInstallSucceeded: boolean;
  llmInstallFailed: boolean;
  llmInstallCanceled: boolean;
  llmProgressPercent: number;
  llmActionError: string | null;
  scannedLlmFor: (id: LlmModelId) => LlmScannedHit | null;
  formatProgressBytes: (n: number | null) => string;
  formatEta: (s: number | null) => string;
}>();

const emit = defineEmits<{
  'update:selectedLlm': [value: LlmModelId];
  'update:llmMirror': [value: LlmMirror];
  'update:llmScanAction': [value: ScanAction];
  cancel: [];
}>();

const { t } = useI18n();

const selectedLlmProxy = computed({
  get: () => props.selectedLlm,
  set: (value: LlmModelId) => emit('update:selectedLlm', value),
});
const llmMirrorProxy = computed({
  get: () => props.llmMirror,
  set: (value: LlmMirror) => emit('update:llmMirror', value),
});
const llmScanActionProxy = computed({
  get: () => props.llmScanAction,
  set: (value: ScanAction) => emit('update:llmScanAction', value),
});
</script>

<template>
  <div class="space-y-3">
    <section
      v-if="lowMemoryWarning"
      class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
    >
      {{ t('desktop.llm.lowMemoryWarning') }}
    </section>

    <section class="space-y-3">
      <div
        v-for="m in tiers"
        :key="m.id"
        class="card-compact transition-colors"
        :class="selectedLlm === m.id ? 'border-primary/50 bg-accent/30' : 'hover:bg-accent/20'"
      >
        <label class="flex cursor-pointer items-center gap-3">
          <input
            v-model="selectedLlmProxy"
            type="radio"
            :value="m.id"
            :disabled="llmInstallRunning"
            class="h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
          <span class="font-medium font-mono">{{ LLM_MODELS[m.id].filename }}</span>
          <Badge v-if="llmStatus.recommended === m.id" variant="secondary">{{ t('desktop.setupWizard.recommended') }}</Badge>
          <span
            v-if="installedLlmIds.has(m.id)"
            class="inline-flex items-center gap-1 text-xs text-success"
          >
            <CheckCircle2 class="h-3.5 w-3.5" />
            {{ t('desktop.llm.alreadyInstalled') }}
          </span>
          <span
            v-else-if="scannedLlmFor(m.id)"
            class="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Link2 class="h-3.5 w-3.5" />
            {{ t('desktop.llm.foundIn', { source: scannedLlmFor(m.id)!.source }) }}
          </span>
          <span class="ml-auto text-sm text-muted-foreground">{{ fmtBytes(LLM_MODELS[m.id].sizeBytes) }}</span>
        </label>

        <div
          v-if="selectedLlm === m.id && scannedLlmFor(m.id) && !installedLlmIds.has(m.id)"
          class="mt-4 space-y-3 border-t border-border pt-3 pl-7"
        >
          <p class="flex items-start gap-1.5 text-sm text-success">
            <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {{ t('desktop.setupWizard.foundAt') }}
              <span class="font-mono text-xs">{{ scannedLlmFor(m.id)!.path }}</span>
              <span class="text-muted-foreground"> ({{ scannedLlmFor(m.id)!.source }})</span>
            </span>
          </p>
          <div class="space-y-2 text-sm">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="llmScanActionProxy"
                type="radio"
                value="symlink"
                :disabled="llmInstallRunning"
                class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
              <span>{{ t('desktop.setupWizard.actionSymlink') }}</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="llmScanActionProxy"
                type="radio"
                value="copy"
                :disabled="llmInstallRunning"
                class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
              <span>{{ t('desktop.setupWizard.actionCopy') }}</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="llmScanActionProxy"
                type="radio"
                value="ignore"
                :disabled="llmInstallRunning"
                class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
              <span>{{ t('desktop.setupWizard.actionIgnore') }}</span>
            </label>
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="!scannedLlmFor(selectedLlm) || llmScanAction === 'ignore'"
      class="rounded-md border border-border/60 bg-muted/30 p-3"
    >
      <label class="flex cursor-pointer items-center gap-3 text-sm">
        <input
          v-model="llmMirrorProxy"
          type="checkbox"
          :true-value="'hf-mirror'"
          :false-value="'auto'"
          :disabled="llmInstallRunning"
          class="size-4 accent-primary"
        >
        <i18n-t keypath="desktop.setupWizard.mirrorToggle" tag="span">
          <template #host><code class="font-mono">hf-mirror.com</code></template>
        </i18n-t>
      </label>
      <p v-if="llmMirror === 'auto'" class="mt-2 text-xs text-muted-foreground">
        {{ $t('desktop.setupWizard.mirrorAutoNote') }}
      </p>
    </section>

    <section
      v-if="llmTask && llmTaskOwnsSelection && llmInstallRunning"
      class="surface-1 space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-4"
    >
      <div class="flex items-center justify-between gap-3">
        <p class="flex items-center gap-2 text-sm font-medium">
          <Loader2 class="h-4 w-4 animate-spin text-primary" />
          <span>
            {{ llmTask.kind === 'download'
              ? t('desktop.setupWizard.downloading')
              : llmTask.kind === 'symlink'
                ? t('desktop.setupWizard.linking')
                : t('desktop.setupWizard.copying') }}
            <span class="font-mono">{{ LLM_MODELS[llmTask.model].filename }}</span>
          </span>
        </p>
        <span class="font-mono text-xs tabular-nums text-muted-foreground">
          {{ llmProgressPercent }}%
        </span>
      </div>
      <Progress :model-value="llmProgressPercent" />
      <div class="flex items-center justify-between gap-3">
        <p v-if="llmTask.progress" class="font-mono text-xs tabular-nums text-muted-foreground">
          {{ formatProgressBytes(llmTask.progress.bytesDownloaded) }} /
          {{ formatProgressBytes(llmTask.progress.bytesTotal) }} ·
          {{ formatProgressBytes(Math.round(llmTask.progress.bytesPerSecond)) }}{{ t('desktop.setupWizard.perSecond') }} ·
          {{ formatEta(llmTask.progress.etaSeconds) }}
        </p>
        <span v-else />
        <Button variant="outline" size="sm" class="shrink-0" @click="emit('cancel')">
          <XIcon class="h-3.5 w-3.5" />
          {{ t('desktop.setupWizard.cancel') }}
        </Button>
      </div>
    </section>

    <section
      v-if="llmInstallSucceeded"
      class="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
    >
      <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ t('desktop.llm.ready', { name: LLM_MODELS[selectedLlm].filename }) }}</span>
    </section>

    <section
      v-if="llmInstallFailed && llmTask"
      class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ t('desktop.llm.installFailed', { error: llmTask.error }) }}</span>
    </section>

    <section
      v-if="llmInstallCanceled"
      class="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
    >
      <span>{{ t('desktop.setupWizard.installCanceled') }}</span>
    </section>

    <div v-if="llmActionError" class="text-sm text-destructive">{{ llmActionError }}</div>
  </div>
</template>
