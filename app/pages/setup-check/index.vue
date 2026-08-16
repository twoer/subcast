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
  sensevoiceReady?: boolean;
}
interface LlmStatusResp {
  installed: Array<{ name: string }>;
}

const { t } = useI18n();
const error = ref<string | null>(null);
const probing = ref(true);

async function probe(): Promise<{ status: SetupStatus; llmStatus: LlmStatusResp }> {
  // Two probes, in parallel: engine readiness (whisper or SenseVoice) and
  // LLM installed-count. The wizard's own resume logic uses the same
  // responses, so the user lands on the right step either way.
  const [status, llmStatus] = await Promise.all([
    $fetch<SetupStatus>('/api/desktop/setup-status'),
    $fetch<LlmStatusResp>('/api/desktop/llm/status'),
  ]);
  return { status, llmStatus };
}

function isReady(status: SetupStatus, llmStatus: LlmStatusResp): boolean {
  // Step 1 is done when EITHER engine is usable — matches the wizard's
  // own resume logic (svReady || hasWhisperModel). SenseVoice-only
  // users (the packaged default) must not be looped back to the wizard.
  return (status.hasWhisperModel || status.sensevoiceReady === true)
    && llmStatus.installed.length > 0;
}

async function check(): Promise<void> {
  error.value = null;
  probing.value = true;
  try {
    let { status, llmStatus } = await probe();
    if (!isReady(status, llmStatus)) {
      // Cold-start races (token injection / first-scan timing) can
      // transiently report an installed model as missing — the wizard
      // would auto-dismiss seconds later anyway. Re-probe once before
      // bouncing the user through it.
      await new Promise((r) => setTimeout(r, 1500));
      ({ status, llmStatus } = await probe());
    }
    await navigateTo(isReady(status, llmStatus) ? '/' : '/setup-wizard', { replace: true });
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
