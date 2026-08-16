<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * First-run setup wizard.
 *
 *   Step 1 — Whisper transcription model: pick a tier and install
 *            (symlink existing file / copy / download from HF).
 *   Step 2 — Local LLM (Qwen 3 GGUF) for AI translation / insights:
 *            pick a tier, mirror, and install (symlink / copy / download
 *            from the same three mirror options Whisper offers).
 *
 * On mount the wizard inspects existing state and jumps to the earliest
 * unmet step so returning users aren't forced through completed work.
 */
import {
  Check,
} from 'lucide-vue-next';
import type { LlmModelId, LlmMirror } from '#shared/llmModels';
import { fmtBytes } from '~/utils/format';
import type {
  InstallKind,
  LlmInstallSnapshot,
  SenseVoiceInstallSnapshot,
  WhisperInstallSnapshot,
} from '#shared/installContracts';
import { useInstallTask } from './useInstallTask';
import WhisperInstallStep from './components/WhisperInstallStep.vue';
import SenseVoiceInstallStep from './components/SenseVoiceInstallStep.vue';
import LlmInstallStep from './components/LlmInstallStep.vue';
import SetupWizardFooter from './components/SetupWizardFooter.vue';
import type {
  LlmScannedHit,
  LlmStatusResp,
  ScanAction,
  ScannedModel,
  SetupStatus,
  WhisperMirror,
  WhisperModelName,
} from '@/types/setupWizard';

const { t } = useI18n();

// --- Static config --------------------------------------------------------

// Static catalog only — no `recommended` flag here. The wizard reads the
// recommendation off `status.value.recommendedWhisperModel` (hardware-tier
// derived) so it stays consistent with Settings → Overview instead of
// pinning a different model.
const MODELS: Array<{ id: WhisperModelName; sizeLabel: string }> = [
  { id: 'tiny', sizeLabel: '77 MB' },
  { id: 'base', sizeLabel: '148 MB' },
  { id: 'small', sizeLabel: '466 MB' },
  { id: 'medium', sizeLabel: '1.5 GB' },
  { id: 'large-v3-turbo', sizeLabel: '1.6 GB' },
];

// Iteration order for the LLM tier cards. Kept as a constant rather than
// `Object.keys(LLM_MODELS)` so the small → large render order is
// deterministic (object iteration order on string keys happens to be
// insertion order, but spelling it out keeps the UI immune to a future
// reorder in the catalog).
const LLM_TIERS: ReadonlyArray<{ id: LlmModelId }> = [
  { id: '4b' },
  { id: '8b' },
  { id: '14b' },
];

// --- State ----------------------------------------------------------------

const currentStep = ref<1 | 2>(1);
const status = ref<SetupStatus | null>(null);
const statusError = ref<string | null>(null);

// Step 1
const selectedEngine = ref<'whisper' | 'sensevoice'>('whisper');
const selectedModel = ref<WhisperModelName>('base');
const scanAction = ref<ScanAction>('symlink');
const mirror = ref<WhisperMirror>('auto');

// --- SenseVoice (step 1 alternate engine) ----------------------------------

interface ModelsAggregate {
  sensevoice?: { ready: boolean };
}
const svReady = ref(false);
const svTask = ref<SenseVoiceInstallSnapshot | null>(null);
const svActionError = ref<string | null>(null);
let svPollTimer: ReturnType<typeof setInterval> | null = null;

const svRunning = computed(() => svTask.value?.state === 'running');
const svSucceeded = computed(() => svTask.value?.state === 'success');
const svFailed = computed(() => svTask.value?.state === 'error');
const svCanceled = computed(() => svTask.value?.state === 'canceled');
const svProgressPercent = computed<number>(() => {
  const p = svTask.value?.progress;
  if (!p || !p.bytesTotal) return 0;
  return Math.min(100, Math.floor((p.bytesDownloaded / p.bytesTotal) * 100));
});

async function loadSvStatus(): Promise<void> {
  try {
    const agg = await $fetch<ModelsAggregate>('/api/desktop/models');
    svReady.value = agg.sensevoice?.ready === true;
    return;
  } catch {
    // Web-mode 404 or probe failure — treat as "not installed"; the
    // whisper flow below still works in that case.
    svReady.value = false;
  }
}

function svStopPolling(): void {
  if (svPollTimer !== null) {
    clearInterval(svPollTimer);
    svPollTimer = null;
  }
}

async function svPollOnce(): Promise<void> {
  try {
    const res = await $fetch<{ install: SenseVoiceInstallSnapshot | null }>(
      '/api/desktop/sensevoice/install',
    );
    svTask.value = res.install ?? null;
  } catch {
    // Next tick retries; the install endpoints are authoritative.
  }
  if (svTask.value && svTask.value.state !== 'running') {
    svStopPolling();
    if (svTask.value.state === 'success') await loadSvStatus();
  }
}

async function startSenseVoiceInstall(): Promise<void> {
  svActionError.value = null;
  try {
    svTask.value = await $fetch<SenseVoiceInstallSnapshot>('/api/desktop/sensevoice/install', {
      method: 'POST',
    });
    if (svTask.value.state === 'running') {
      svPollOnce();
      svStopPolling();
      svPollTimer = setInterval(() => { void svPollOnce(); }, 1000);
    } else if (svTask.value.state === 'success') {
      await loadSvStatus();
    }
  } catch (e) {
    const err = e as { statusMessage?: string; message?: string };
    svActionError.value =
      err.statusMessage ?? err.message ?? t('desktop.setupWizard.installStartFailed');
  }
}

async function cancelSenseVoiceInstall(): Promise<void> {
  try {
    await $fetch('/api/desktop/sensevoice/install', { method: 'DELETE' });
  } catch { /* surface via next poll */ }
}

// Step 2 (LLM)
const llmStatus = ref<LlmStatusResp | null>(null);
const selectedLlm = ref<LlmModelId>('8b');
const llmMirror = ref<LlmMirror>('auto');
const llmScanAction = ref<ScanAction>('symlink');

// --- Status fetch ---------------------------------------------------------

async function loadStatus(): Promise<void> {
  statusError.value = null;
  try {
    status.value = await $fetch<SetupStatus>('/api/desktop/setup-status');
  } catch (e) {
    statusError.value = e instanceof Error ? e.message : t('desktop.setupCheck.probeFailed');
  }
}

async function loadLlmStatus(): Promise<void> {
  try {
    llmStatus.value = await $fetch<LlmStatusResp>('/api/desktop/llm/status');
  } catch (e) {
    // Surface in the same banner as the Whisper probe error — the wizard
    // can't make decisions without it.
    statusError.value = e instanceof Error ? e.message : t('desktop.setupCheck.probeFailed');
  }
}

// --- Install state machines (one composable, two instances) ---------------
// Whisper (step 1) and LLM (step 2) share the same poll / start / cancel
// behavior; only the endpoint and snapshot type differ. The composable
// also auto-cleans its poll timer in onBeforeUnmount, so we don't need
// to maintain a separate teardown hook here.

const whisper = useInstallTask<WhisperInstallSnapshot>({
  endpoint: '/api/desktop/whisper/install',
  selected: selectedModel,
  onSuccess: loadStatus,
});
const llm = useInstallTask<LlmInstallSnapshot>({
  endpoint: '/api/desktop/llm/install',
  selected: selectedLlm,
  onSuccess: loadLlmStatus,
});

// Aliases keep the existing template bindings working unchanged.
const task = whisper.task;
const actionError = whisper.actionError;
const taskOwnsSelection = whisper.ownsSelection;
const installRunning = whisper.running;
const installFinished = whisper.succeeded;
const installFailed = whisper.failed;
const installCanceled = whisper.canceled;
const progressPercent = whisper.progressPercent;

const llmTask = llm.task;
const llmActionError = llm.actionError;
const llmTaskOwnsSelection = llm.ownsSelection;
const llmInstallRunning = llm.running;
const llmInstallSucceeded = llm.succeeded;
const llmInstallFailed = llm.failed;
const llmInstallCanceled = llm.canceled;
const llmProgressPercent = llm.progressPercent;

// --- Step 1 (Whisper) — scan helpers, install body builder ----------------

/**
 * All scan hits for `selectedModel`. The first installed hit (canonical
 * dir) takes precedence over external matches — the UI uses this to
 * gate whether the symlink/copy/ignore picker shows up at all.
 */
const matchesForSelected = computed<ScannedModel[]>(() =>
  status.value?.whisperModels.filter((m) => m.name === selectedModel.value) ?? [],
);
const installedMatch = computed<ScannedModel | null>(
  () => matchesForSelected.value.find((m) => m.installed) ?? null,
);
const scannedMatch = computed<ScannedModel | null>(
  () => matchesForSelected.value.find((m) => !m.installed) ?? null,
);

/** Per-model status used for the inline pill on each card. */
function statusForModel(name: WhisperModelName): 'installed' | 'available' | 'missing' {
  const hits = status.value?.whisperModels.filter((m) => m.name === name) ?? [];
  if (hits.some((h) => h.installed)) return 'installed';
  if (hits.length > 0) return 'available';
  return 'missing';
}

/** External (non-canonical) hits per model — drives the "本机已有" hint. */
function externalSource(name: WhisperModelName): string | null {
  const hit = status.value?.whisperModels.find((m) => m.name === name && !m.installed);
  return hit?.source ?? null;
}

async function startInstall(): Promise<void> {
  if (selectedEngine.value === 'sensevoice') {
    await startSenseVoiceInstall();
    return;
  }
  const useScanned = scannedMatch.value !== null && scanAction.value !== 'ignore';
  const kind: InstallKind = useScanned
    ? (scanAction.value as 'symlink' | 'copy')
    : 'download';

  const body: Record<string, unknown> = { kind, model: selectedModel.value };
  if (useScanned) body.srcPath = scannedMatch.value!.path;
  else body.mirror = mirror.value;

  await whisper.startInstall(body);
}

async function cancelInstall(): Promise<void> {
  if (selectedEngine.value === 'sensevoice') {
    await cancelSenseVoiceInstall();
    return;
  }
  await whisper.cancelInstall();
}

// --- Step 2 (LLM) — scan helpers, install body builder --------------------

/** Set of tier ids that already have a GGUF in the canonical install dir. */
const installedLlmIds = computed<Set<LlmModelId>>(
  () => new Set((llmStatus.value?.installed ?? []).map((m) => m.name)),
);

/**
 * First scan hit (outside the canonical install dir) for a tier, or
 * `null` if nothing was found. Drives the "扫描到 (LM Studio)" hint +
 * the symlink/copy/ignore picker on the selected card. Returns `null`
 * instead of `undefined` so v-if guards stay consistent across the
 * template.
 */
function scannedLlmFor(id: LlmModelId): LlmScannedHit | null {
  return (llmStatus.value?.scanned ?? []).find((m) => m.name === id) ?? null;
}

const lowMemoryWarning = computed<boolean>(
  // Show the banner when we know memory is below 8 GB. Default to false
  // (don't warn) when the status hasn't loaded yet to avoid a one-frame
  // flash on a fast-loading status response.
  () => (llmStatus.value?.totalMemoryGB ?? 999) < 8,
);

async function startLlmInstall(): Promise<void> {
  const scanned = scannedLlmFor(selectedLlm.value);
  const useScanned = scanned !== null && llmScanAction.value !== 'ignore';
  const kind: InstallKind = useScanned
    ? (llmScanAction.value as 'symlink' | 'copy')
    : 'download';

  const body: Record<string, unknown> = { kind, model: selectedLlm.value };
  if (useScanned) body.srcPath = scanned!.path;
  else body.mirror = llmMirror.value;

  await llm.startInstall(body);
}

async function cancelLlmInstall(): Promise<void> {
  await llm.cancelInstall();
}

/**
 * Same idea as `pickWhisperDefault`: prefer the largest model already
 * canonically installed → the largest available externally (so
 * symlink/copy is one click away) → the migration-hint from the legacy
 * `ollamaModel` field if present → finally the server's hardware-tier
 * recommendation.
 */
function pickLlmDefault(): LlmModelId {
  const order: LlmModelId[] = ['14b', '8b', '4b'];
  for (const id of order) if (installedLlmIds.value.has(id)) return id;
  for (const id of order) if (scannedLlmFor(id) !== null) return id;
  if (llmStatus.value?.migrationHint) return llmStatus.value.migrationHint;
  return llmStatus.value?.recommended ?? '8b';
}

/**
 * Same idea as `pickLlmDefault`: prefer the largest model already
 * canonically installed, then the largest available externally (so
 * symlink/copy is one click away); finally fall back to whatever the
 * server's hardware-tier recommendation is (matches Settings →
 * Overview); finally `base` as an ultra-safe last resort.
 */
function pickWhisperDefault(): WhisperModelName {
  const order: WhisperModelName[] = ['large-v3-turbo', 'medium', 'small', 'base', 'tiny'];
  for (const m of order) if (statusForModel(m) === 'installed') return m;
  for (const m of order) if (statusForModel(m) === 'available') return m;
  return status.value?.recommendedWhisperModel ?? 'base';
}

// --- Lifecycle ------------------------------------------------------------

async function enterStep(step: 1 | 2): Promise<void> {
  currentStep.value = step;
  if (step === 2) {
    if (!llmStatus.value) await loadLlmStatus();
    selectedLlm.value = pickLlmDefault();
    await llm.pollOnce();
    if (llm.task.value?.state === 'running') llm.startPolling();
  } else {
    llm.stopPolling();
  }
}

const route = useRoute();

/**
 * Entry-context aware: when ?step= is in the URL we came from
 * Settings → Models "下载更多" rather than the first-run flow. Drives
 * the title + footer labels so users in manage mode aren't told they're
 * doing "first-run setup".
 */
const isManageEntry = computed<boolean>(() => {
  const s = Number(route.query.step);
  return s === 1 || s === 2;
});

const wizardTitle = computed<string>(() =>
  isManageEntry.value ? t('desktop.setupWizard.manageTitle') : t('desktop.setupWizard.welcome'),
);

onMounted(async () => {
  await Promise.all([loadStatus(), loadLlmStatus(), loadSvStatus()]);
  await whisper.pollOnce();
  if (whisper.task.value?.state === 'running') whisper.startPolling();
  await svPollOnce();
  if (svTask.value?.state === 'running') {
    svStopPolling();
    svPollTimer = setInterval(() => { void svPollOnce(); }, 1000);
  }

  // Default to the most useful Whisper model based on what's already
  // on disk — largest installed → largest reusable → base.
  if (status.value) selectedModel.value = pickWhisperDefault();
  if (llmStatus.value) selectedLlm.value = pickLlmDefault();

  // Engine default for step 1 — decides which model card to show, NOT the
  // runtime engine (the wizard always persists `auto`; see
  // persistWhisperChoice). Prefer what's already usable: SenseVoice
  // installed → its card (one click through); otherwise a whisper model
  // on disk → whisper card; fresh install → SenseVoice card (bundled in
  // packaged builds, smallest download otherwise).
  if (svReady.value || !status.value?.hasWhisperModel) {
    selectedEngine.value = 'sensevoice';
  } else {
    selectedEngine.value = 'whisper';
  }
  // `?engine=whisper` from the player's "Download Whisper" hint: the user
  // already knows what they came for — preselect that card instead of the
  // usable-engine default (which would show SenseVoice).
  if (route.query.engine === 'whisper') {
    selectedEngine.value = 'whisper';
  }

  // `?step=1|2` from Settings → Models "Download more" buttons forces
  // landing on that step even when first-run setup is fully complete —
  // otherwise the auto-redirect below would bounce the user home.
  const forcedStep = Number(route.query.step);
  if (forcedStep === 1 || forcedStep === 2) {
    await enterStep(forcedStep);
    return;
  }

  // First-run flow: resume from earliest unmet step, or fast-forward home
  // if every dependency is already satisfied. The LLM-installed proxy for
  // the old `hasQwen` flag is `llmStatus.installed.length > 0`.
  if (!status.value) return;
  const hasAnyLlm = (llmStatus.value?.installed.length ?? 0) > 0;
  // Step 1 is satisfied by EITHER engine's model being usable — `auto`
  // dispatches at runtime and falls back to whatever is installed.
  const step1Done = status.value.hasWhisperModel || svReady.value;
  if (step1Done && hasAnyLlm) {
    await navigateTo('/', { replace: true });
    return;
  }
  if (step1Done) {
    await enterStep(2);
  }
});

// Polling cleanup: whisper/llm handled by `useInstallTask`'s own
// onBeforeUnmount; the SenseVoice timer is ours.
onBeforeUnmount(() => {
  svStopPolling();
});

// --- Navigation -----------------------------------------------------------

const canAdvanceStep1 = computed<boolean>(() => {
  if (selectedEngine.value === 'sensevoice') {
    // Ready from a previous session, or just finished downloading here.
    return svReady.value || svSucceeded.value;
  }
  // Selected model is already canonically installed — no further action.
  if (installedMatch.value !== null) return true;
  // Or we just finished installing the selected model this session.
  return installFinished.value;
});

const canFinish = computed<boolean>(
  // Finish enabled when the selected LLM tier is reachable: either
  // already installed in the canonical dir, or we just finished
  // symlinking / copying / downloading it.
  () => installedLlmIds.value.has(selectedLlm.value) || llmInstallSucceeded.value,
);

/**
 * Persist the whisper tier + engine choice when advancing past step 1.
 * Without this, first-boot defaults (set by hardware tier in
 * `01.first-boot.ts`) win and the transcribe handler later looks for a
 * model the wizard never actually installed — yielding "Model not
 * downloaded" mid-flow.
 *
 * The engine is always persisted as `auto` regardless of which card the
 * user filled: the cards decide WHICH models are on disk, `auto` picks
 * per audio (CJK → SenseVoice, English → Whisper when installed).
 * Users who want a pinned engine set it in Settings → Models.
 */
async function persistWhisperChoice(): Promise<void> {
  try {
    await $fetch('/api/settings', {
      method: 'PUT',
      body: {
        // Only carry the whisper tier over when the Whisper card is the one
        // being completed. On the SenseVoice path `selectedModel` still
        // holds the hardware-recommended tier (e.g. large-v3-turbo) that
        // the user never installed — persisting it leaves Settings →
        // Models pointing at a missing model. The PUT is a merge, so
        // omitting the key keeps the existing (first-boot) default.
        ...(selectedEngine.value === 'whisper' ? { whisperModel: selectedModel.value } : {}),
        transcribeEngine: 'auto',
      },
    });
  } catch {
    // Non-fatal: a settings write failure shouldn't block the wizard.
    // The next launch's setup-check will surface the mismatch.
  }
}

async function persistLlmChoice(): Promise<void> {
  try {
    await $fetch('/api/settings', {
      method: 'PUT',
      body: { llmModel: selectedLlm.value },
    });
  } catch { /* see persistWhisperChoice */ }
}

async function goNextStep(): Promise<void> {
  if (currentStep.value === 1 && canAdvanceStep1.value) {
    await persistWhisperChoice();
    await enterStep(2);
  } else if (currentStep.value === 2) {
    await persistLlmChoice();
    await navigateTo('/');
  }
}

async function goPrevStep(): Promise<void> {
  if (currentStep.value === 2) await enterStep(1);
}

// --- UI helpers -----------------------------------------------------------

// Footer bindings for step 1 are engine-aware: the SenseVoice branch
// maps onto the same props (no scan flow → always the "download" button;
// "installed" = model files present).
const footerStep1 = computed(() =>
  selectedEngine.value === 'sensevoice'
    ? {
        hasScannedWhisper: false,
        hasInstalledWhisper: svReady.value,
        installRunning: svRunning.value,
        installFinished: svSucceeded.value,
      }
    : {
        hasScannedWhisper: scannedMatch.value !== null,
        hasInstalledWhisper: installedMatch.value !== null,
        installRunning: installRunning.value,
        installFinished: installFinished.value,
      },
);

function formatProgressBytes(n: number | null): string {
  if (n === null) return '?';
  return fmtBytes(n);
}
function formatEta(s: number | null): string {
  if (s === null) return '—';
  if (s < 60) return t('desktop.setupWizard.remainingSecs', { n: s });
  const m = Math.floor(s / 60);
  return t('desktop.setupWizard.remainingMins', { m, s: s % 60 });
}
</script>

<template>
  <AppShell>
    <template #header>
      <AppHeader :show-primary-nav="false" />
    </template>
    <div class="mx-auto max-w-2xl space-y-8">
      <header class="space-y-4">
        <h1 class="text-2xl font-semibold">{{ wizardTitle }}</h1>

        <ol class="flex items-start" aria-label="Setup progress">
          <template
            v-for="(label, i) in [
              t('desktop.setupWizard.stepLabel1'),
              t('desktop.setupWizard.stepLabel2'),
            ]"
            :key="i"
          >
            <li
              class="flex flex-col items-center gap-1.5"
              :aria-current="currentStep === i + 1 ? 'step' : undefined"
            >
              <div
                class="grid h-8 w-8 place-items-center rounded-full text-xs font-semibold transition-colors"
                :class="
                  currentStep > i + 1
                    ? 'bg-success text-success-foreground'
                    : currentStep === i + 1
                      ? 'bg-primary text-primary-foreground'
                      : 'border-2 border-border bg-background text-muted-foreground'
                "
              >
                <Check v-if="currentStep > i + 1" class="h-4 w-4" />
                <span v-else>{{ i + 1 }}</span>
              </div>
              <span
                class="text-xs font-medium"
                :class="currentStep >= i + 1 ? 'text-foreground' : 'text-muted-foreground'"
              >{{ label }}</span>
            </li>
            <li
              v-if="i < 1"
              class="mx-1 mt-4 h-0.5 flex-1 rounded-full transition-colors"
              :class="currentStep > i + 1 ? 'bg-success' : 'bg-border'"
            />
          </template>
        </ol>

        <p class="text-sm text-muted-foreground">
          <template v-if="currentStep === 1">{{ t('desktop.setupWizard.subtitleStep1') }}</template>
          <template v-else>{{ t('desktop.setupWizard.subtitleStep2') }}</template>
        </p>
      </header>

      <div
        v-if="statusError"
        class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ statusError }}
      </div>

      <!-- ===== Step 1 — transcription engine + model ===== -->
      <template v-if="currentStep === 1">
        <!-- Engine choice: Whisper (broad) vs SenseVoice (fast zh/en). -->
        <section class="space-y-2">
          <p class="text-sm font-medium">{{ t('desktop.setupWizard.engineChoiceTitle') }}</p>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              class="rounded-lg border p-3 text-left transition-colors"
              :class="selectedEngine === 'sensevoice'
                ? 'border-primary bg-primary/[0.04]'
                : 'border-border hover:border-primary/40'"
              :aria-pressed="selectedEngine === 'sensevoice'"
              @click="selectedEngine = 'sensevoice'"
            >
              <span class="block text-sm font-medium">
                {{ t('desktop.setupWizard.engineSensevoiceName') }}
                <span
                  class="ml-1 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
                >{{ t('desktop.setupWizard.engineSensevoiceBadge') }}</span>
              </span>
              <span class="mt-0.5 block text-xs text-muted-foreground">
                {{ t('desktop.setupWizard.engineSensevoiceDesc') }}
              </span>
            </button>
            <button
              type="button"
              class="rounded-lg border p-3 text-left transition-colors"
              :class="selectedEngine === 'whisper'
                ? 'border-primary bg-primary/[0.04]'
                : 'border-border hover:border-primary/40'"
              :aria-pressed="selectedEngine === 'whisper'"
              @click="selectedEngine = 'whisper'"
            >
              <span class="block text-sm font-medium">
                {{ t('desktop.setupWizard.engineWhisperName') }}
              </span>
              <span class="mt-0.5 block text-xs text-muted-foreground">
                {{ t('desktop.setupWizard.engineWhisperDesc') }}
              </span>
            </button>
          </div>
        </section>

        <WhisperInstallStep
          v-if="status && selectedEngine === 'whisper'"
          v-model:selected-model="selectedModel"
          v-model:scan-action="scanAction"
          v-model:mirror="mirror"
          :models="MODELS"
          :status="status"
          :scanned-match="scannedMatch"
          :installed-match="installedMatch"
          :task="task"
          :task-owns-selection="taskOwnsSelection"
          :install-running="installRunning"
          :install-finished="installFinished"
          :install-failed="installFailed"
          :install-canceled="installCanceled"
          :progress-percent="progressPercent"
          :action-error="actionError"
          :status-for-model="statusForModel"
          :external-source="externalSource"
          :format-progress-bytes="formatProgressBytes"
          :format-eta="formatEta"
          @cancel="cancelInstall"
        />
        <SenseVoiceInstallStep
          v-else-if="selectedEngine === 'sensevoice'"
          :ready="svReady"
          :task="svTask"
          :running="svRunning"
          :finished="svSucceeded"
          :failed="svFailed"
          :canceled="svCanceled"
          :progress-percent="svProgressPercent"
          :action-error="svActionError"
          :format-progress-bytes="formatProgressBytes"
          :format-eta="formatEta"
          @cancel="cancelSenseVoiceInstall"
        />
      </template>

      <!-- ===== Step 2 — LLM (Qwen 3 GGUF) ===== -->
      <template v-else-if="currentStep === 2">
        <LlmInstallStep
          v-if="llmStatus"
          v-model:selected-llm="selectedLlm"
          v-model:llm-mirror="llmMirror"
          v-model:llm-scan-action="llmScanAction"
          :tiers="LLM_TIERS"
          :llm-status="llmStatus"
          :installed-llm-ids="installedLlmIds"
          :low-memory-warning="lowMemoryWarning"
          :llm-task="llmTask"
          :llm-task-owns-selection="llmTaskOwnsSelection"
          :llm-install-running="llmInstallRunning"
          :llm-install-succeeded="llmInstallSucceeded"
          :llm-install-failed="llmInstallFailed"
          :llm-install-canceled="llmInstallCanceled"
          :llm-progress-percent="llmProgressPercent"
          :llm-action-error="llmActionError"
          :scanned-llm-for="scannedLlmFor"
          :format-progress-bytes="formatProgressBytes"
          :format-eta="formatEta"
          @cancel="cancelLlmInstall"
        />
      </template>

      <SetupWizardFooter
        :current-step="currentStep"
        :status-ready="!!status"
        :scan-action="scanAction"
        :has-scanned-whisper="footerStep1.hasScannedWhisper"
        :has-installed-whisper="footerStep1.hasInstalledWhisper"
        :install-running="footerStep1.installRunning"
        :install-finished="footerStep1.installFinished"
        :can-advance-step1="canAdvanceStep1"
        :llm-status-ready="!!llmStatus"
        :llm-scan-action="llmScanAction"
        :has-scanned-llm="scannedLlmFor(selectedLlm) !== null"
        :has-installed-llm="installedLlmIds.has(selectedLlm)"
        :llm-install-running="llmInstallRunning"
        :llm-install-succeeded="llmInstallSucceeded"
        :can-finish="canFinish"
        @prev="goPrevStep"
        @next="goNextStep"
        @start-whisper-install="startInstall"
        @start-llm-install="startLlmInstall"
      />
    </div>
  </AppShell>
</template>
