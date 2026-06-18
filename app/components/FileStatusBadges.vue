<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { Check, Loader2, Sparkles, AlertCircle, Languages, Clock } from 'lucide-vue-next';
import type { FileStatus } from '~/utils/fileStatus';

defineProps<{ status: FileStatus }>();
</script>

<template>
  <div class="flex flex-wrap items-center gap-1">
    <span
      v-if="status.transcribe === 'running'"
      class="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-primary"
    >
      <Loader2 class="h-3 w-3 animate-spin" />
      {{ $t('fileStatus.transcribing', { pct: status.transcribeProgress ?? 0 }) }}
    </span>
    <span
      v-else-if="status.transcribe === 'queued'"
      class="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
    >
      <Clock class="h-3 w-3" />
      {{ $t('fileStatus.transcribeQueued') }}
    </span>
    <span
      v-else-if="status.transcribe === 'failed'"
      class="inline-flex items-center gap-1 rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-3xs font-medium text-destructive"
      :title="status.transcribeError ?? undefined"
    >
      <AlertCircle class="h-3 w-3" />
      {{ $t('fileStatus.transcribeFailed') }}
    </span>
    <span
      v-else-if="status.transcribe === 'done'"
      class="inline-flex items-center gap-1 rounded-sm border border-success/30 bg-success/10 px-1.5 py-0.5 text-3xs font-medium text-success"
    >
      <Check class="h-3 w-3" />
      {{ $t('fileStatus.transcribed') }}
    </span>

    <span
      v-if="status.translateRunning"
      class="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-primary"
    >
      <Loader2 class="h-3 w-3 animate-spin" />
      {{
        $t('fileStatus.translating', {
          lang: status.translateRunning.targetLang,
          pct: status.translateRunning.progress,
        })
      }}
    </span>
    <span
      v-else-if="status.translateQueued"
      class="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
    >
      <Clock class="h-3 w-3" />
      {{ $t('fileStatus.translateQueued', { lang: status.translateQueued.targetLang }) }}
    </span>
    <span
      v-else-if="status.translatedCount > 0"
      class="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
    >
      <Languages class="h-3 w-3" />
      {{ $t('fileStatus.translatedCount', { n: status.translatedCount }) }}
    </span>
    <span
      v-else-if="status.translateFailed"
      class="inline-flex items-center gap-1 rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-3xs font-medium text-destructive"
    >
      <AlertCircle class="h-3 w-3" />
      {{ $t('fileStatus.translateFailed') }}
    </span>

    <span
      v-if="status.insight === 'running'"
      class="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-primary"
    >
      <Loader2 class="h-3 w-3 animate-spin" />
      {{ $t('fileStatus.aiRunning') }}
    </span>
    <span
      v-else-if="status.insight === 'done'"
      class="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground"
    >
      <Sparkles class="h-3 w-3" />
      {{ $t('fileStatus.aiReady') }}
    </span>
  </div>
</template>
