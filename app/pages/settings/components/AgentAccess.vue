<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { Bot, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-vue-next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const { t } = useI18n();
const desktop = useDesktop();

const enabled = ref<boolean | null>(null);
const busy = ref(false);
const refreshing = ref(false);
const actionFailed = ref(false);
const showConsent = ref(false);

async function refresh(): Promise<void> {
  refreshing.value = true;
  actionFailed.value = false;
  try {
    enabled.value = (await desktop.getAgentAccessStatus()).enabled;
  } catch {
    actionFailed.value = true;
  } finally {
    refreshing.value = false;
  }
}

async function confirmEnable(): Promise<void> {
  busy.value = true;
  actionFailed.value = false;
  try {
    enabled.value = (await desktop.enableAgentAccess()).enabled;
    if (enabled.value) showConsent.value = false;
  } catch {
    actionFailed.value = true;
  } finally {
    busy.value = false;
  }
}

async function disable(): Promise<void> {
  busy.value = true;
  actionFailed.value = false;
  try {
    enabled.value = (await desktop.disableAgentAccess()).enabled;
  } catch {
    actionFailed.value = true;
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <section class="card space-y-6">
    <header class="flex items-start gap-3">
      <Bot class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
      <div class="min-w-0">
        <h2 class="text-base font-semibold">{{ t('settings.assistant.title') }}</h2>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.assistant.description') }}</p>
      </div>
    </header>

    <div class="flex flex-col gap-4 border-y border-border/60 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-start gap-3" aria-live="polite">
        <RefreshCw
          v-if="enabled === null"
          class="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
        <ShieldCheck
          v-else-if="enabled"
          class="mt-0.5 size-5 shrink-0 text-emerald-500"
          aria-hidden="true"
        />
        <ShieldOff
          v-else
          class="mt-0.5 size-5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div class="min-w-0">
          <p class="text-sm font-medium">
            {{ enabled === null ? t('settings.loading') : enabled ? t('settings.assistant.enabled') : t('settings.assistant.disabled') }}
          </p>
          <p v-if="enabled !== null" class="mt-1 text-xs text-muted-foreground">
            {{ enabled ? t('settings.assistant.enabledHint') : t('settings.assistant.disabledHint') }}
          </p>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="busy || refreshing"
          :aria-label="t('settings.assistant.refresh')"
          :title="t('settings.assistant.refresh')"
          @click="refresh"
        >
          <RefreshCw class="size-4 shrink-0" :class="{ 'animate-spin': refreshing }" aria-hidden="true" />
        </Button>
        <Button
          v-if="enabled === true"
          variant="outline"
          :disabled="busy || refreshing"
          @click="disable"
        >
          <span class="inline-flex items-center gap-1.5">
            <ShieldOff class="size-4 shrink-0" aria-hidden="true" />
            <span>{{ t('settings.assistant.disable') }}</span>
          </span>
        </Button>
        <Button
          v-else
          :disabled="busy || refreshing || !desktop.isDesktop || enabled === null"
          @click="showConsent = true"
        >
          <span class="inline-flex items-center gap-1.5">
            <ShieldCheck class="size-4 shrink-0" aria-hidden="true" />
            <span>{{ t('settings.assistant.enable') }}</span>
          </span>
        </Button>
      </div>
    </div>

    <p class="text-xs leading-5 text-muted-foreground">
      {{ t('settings.assistant.sessionHint') }}
    </p>

    <Alert v-if="actionFailed" variant="destructive">
      <AlertDescription>{{ t('settings.assistant.actionFailed') }}</AlertDescription>
    </Alert>

    <Dialog v-model:open="showConsent">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Bot class="size-5 shrink-0 text-primary" aria-hidden="true" />
            <span>{{ t('settings.assistant.consentTitle') }}</span>
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('settings.assistant.consentDescription') }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4 text-sm">
          <div class="flex items-start gap-3">
            <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p class="font-medium">{{ t('settings.assistant.consentScopeTitle') }}</p>
              <p class="mt-1 text-muted-foreground">{{ t('settings.assistant.consentScopeDescription') }}</p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <ShieldOff class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div>
              <p class="font-medium">{{ t('settings.assistant.consentSessionTitle') }}</p>
              <p class="mt-1 text-muted-foreground">{{ t('settings.assistant.consentSessionDescription') }}</p>
            </div>
          </div>
        </div>

        <DialogFooter class="gap-2 sm:gap-2">
          <Button variant="outline" :disabled="busy" @click="showConsent = false">
            {{ t('common.cancel') }}
          </Button>
          <Button :disabled="busy" @click="confirmEnable">
            <span class="inline-flex items-center gap-1.5">
              <ShieldCheck class="size-4 shrink-0" aria-hidden="true" />
              <span>{{ t('settings.assistant.consentConfirm') }}</span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
