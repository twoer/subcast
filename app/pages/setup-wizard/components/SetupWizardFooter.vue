<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { Button } from '~/components/ui/button';
import type { ScanAction } from '@/types/setupWizard';

defineProps<{
  currentStep: 1 | 2;
  statusReady: boolean;
  scanAction: ScanAction;
  hasScannedWhisper: boolean;
  hasInstalledWhisper: boolean;
  installRunning: boolean;
  installFinished: boolean;
  canAdvanceStep1: boolean;
  llmStatusReady: boolean;
  llmScanAction: ScanAction;
  hasScannedLlm: boolean;
  hasInstalledLlm: boolean;
  llmInstallRunning: boolean;
  llmInstallSucceeded: boolean;
  canFinish: boolean;
}>();

const emit = defineEmits<{
  prev: [];
  next: [];
  startWhisperInstall: [];
  startLlmInstall: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex items-center justify-between border-t border-border pt-6">
    <div class="flex items-center gap-3">
      <NuxtLink to="/" class="text-sm text-muted-foreground hover:text-foreground">{{ t('desktop.setupWizard.skip') }}</NuxtLink>
      <Button
        v-if="currentStep > 1"
        variant="outline"
        size="sm"
        @click="emit('prev')"
      >
        <ChevronLeft class="h-4 w-4" />
        {{ t('desktop.setupWizard.back') }}
      </Button>
    </div>
    <div class="flex gap-2">
      <Button
        v-if="currentStep === 1 && !installFinished && !hasInstalledWhisper && !installRunning"
        :disabled="!statusReady"
        @click="emit('startWhisperInstall')"
      >
        {{ hasScannedWhisper && scanAction !== 'ignore'
          ? (scanAction === 'symlink'
            ? t('desktop.setupWizard.linkExisting')
            : t('desktop.setupWizard.copyExisting'))
          : t('desktop.setupWizard.download') }}
      </Button>
      <Button
        v-if="currentStep === 1"
        :disabled="!canAdvanceStep1"
        @click="emit('next')"
      >
        {{ t('desktop.setupWizard.next') }}
        <ChevronRight class="h-4 w-4" />
      </Button>
      <Button
        v-if="currentStep === 2 && !llmInstallSucceeded && !hasInstalledLlm && !llmInstallRunning"
        :disabled="!llmStatusReady"
        @click="emit('startLlmInstall')"
      >
        {{ hasScannedLlm && llmScanAction !== 'ignore'
          ? (llmScanAction === 'symlink'
            ? t('desktop.setupWizard.linkExisting')
            : t('desktop.setupWizard.copyExisting'))
          : t('desktop.setupWizard.download') }}
      </Button>
      <Button
        v-if="currentStep === 2"
        :disabled="!canFinish"
        @click="emit('next')"
      >{{ t('desktop.setupWizard.finish') }}</Button>
    </div>
  </div>
</template>
