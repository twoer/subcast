<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * First-run gate for the desktop shell.
 *
 * Probes `/api/desktop/setup-status` once on mount, then:
 *   - all dependencies satisfied → navigate to home (`/`)
 *   - any dependency missing      → navigate to `/setup-wizard`
 *   - probe failed                → show a retry button
 *
 * Renders a minimal spinner shell during probing so the window doesn't
 * flash blank while waiting on Ollama / scan I/O.
 *
 * Web mode: the endpoint 404s; we redirect to home so the SSR landing
 * page can handle the rest.
 */

import { Button } from '~/components/ui/button';

interface SetupStatus {
  hasWhisperModel: boolean;
}
interface LlmStatusResp {
  installed: Array<{ name: string }>;
}

const { t } = useI18n();
const error = ref<string | null>(null);
const probing = ref(true);

async function check(): Promise<void> {
  error.value = null;
  probing.value = true;
  try {
    // Two probes, in parallel: Whisper readiness (unchanged) and LLM
    // installed-count (replaces the old `hasQwen` flag from setup-status).
    // The wizard's own resume logic uses the same llm/status response, so
    // the user lands on the right step either way.
    const [status, llmStatus] = await Promise.all([
      $fetch<SetupStatus>('/api/desktop/setup-status'),
      $fetch<LlmStatusResp>('/api/desktop/llm/status'),
    ]);
    const ready = status.hasWhisperModel && llmStatus.installed.length > 0;
    await navigateTo(ready ? '/' : '/setup-wizard', { replace: true });
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    if (err.statusCode === 404) {
      await navigateTo('/', { replace: true });
      return;
    }
    error.value = err.message ?? t('desktop.setupCheck.probeFailed');
  } finally {
    probing.value = false;
  }
}

onMounted(() => {
  void check();
});
</script>

<template>
  <main class="flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-foreground">
    <div class="flex flex-col items-center gap-4">
      <template v-if="probing">
        <div class="size-8 animate-spin rounded-full border-2 border-border border-t-foreground" />
        <p class="text-sm text-muted-foreground">{{ t('desktop.setupCheck.checking') }}</p>
      </template>
      <template v-else-if="error">
        <p class="text-sm text-destructive">{{ error }}</p>
        <Button variant="outline" size="sm" @click="check">
          {{ t('desktop.setupCheck.retry') }}
        </Button>
      </template>
    </div>
  </main>
</template>
