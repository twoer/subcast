<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
/**
 * First-run setup wizard.
 *
 *   Step 1 — Whisper transcription model: pick a tier and install
 *            (symlink existing file / copy / download from HF).
 *   Step 2 — Local LLM (Qwen 2.5 GGUF) for AI translation / insights:
 *            pick a tier, mirror, and install (symlink / copy / download
 *            from the same three mirror options Whisper offers).
 *
 * On mount the wizard inspects existing state and jumps to the earliest
 * unmet step so returning users aren't forced through completed work.
 */
import { Button } from '~/components/ui/button';
import { Progress } from '~/components/ui/progress';
import { Badge } from '~/components/ui/badge';
import {
  CheckCircle2,
  Link2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Loader2,
  X as XIcon,
  Check,
} from 'lucide-vue-next';
import type { LlmModelId, LlmMirror } from '../../desktop/modelManager/llmConfig';
import { LLM_MODELS } from '../../desktop/modelManager/llmConfig';
// The setup-wizard's Whisper choices are a curated subset of
// WHISPER_MODEL_NAMES (the wizard intentionally omits large-v3 in favor
// of large-v3-turbo as the high-end pick). The type still uses the
// canonical union so a future addition to WHISPER_MODEL_NAMES surfaces
// here as a type error if the wizard should adopt it.
import type { WhisperModelName as CanonicalWhisperModelName } from '#shared/whisperModels';

const { t } = useI18n();

// --- Types ----------------------------------------------------------------

type WhisperModelName = Extract<
  CanonicalWhisperModelName,
  'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo'
>;
type WhisperMirror = 'huggingface' | 'hf-mirror';
type InstallKind = 'symlink' | 'copy' | 'download';
type InstallState = 'running' | 'success' | 'error' | 'canceled';
type ScanAction = 'symlink' | 'copy' | 'ignore';

interface ScannedModel {
  name: WhisperModelName;
  path: string;
  source: string;
  /** True iff the scan hit is in Subcast's canonical install dir. */
  installed: boolean;
}
interface SetupStatus {
  hasWhisperModel: boolean;
  whisperModels: ScannedModel[];
  /**
   * Hardware-tier-derived recommendation from `server/utils/hardware.ts`.
   * Drives the "推荐" badge in the wizard so it matches Settings →
   * Overview instead of a hard-coded `base`.
   */
  recommendedWhisperModel: WhisperModelName;
}
interface DownloadProgress {
  bytesDownloaded: number;
  bytesTotal: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
}
interface InstallSnapshot {
  id: number;
  kind: InstallKind;
  model: WhisperModelName;
  mirror?: WhisperMirror;
  state: InstallState;
  progress?: DownloadProgress;
  destPath?: string;
  error?: string;
}

interface LlmInstalledHit {
  name: LlmModelId;
  path: string;
  sizeBytes: number;
}
interface LlmScannedHit {
  name: LlmModelId;
  path: string;
  source: string;
  sizeBytes: number;
}
interface LlmStatusResp {
  active: LlmModelId | undefined;
  recommended: LlmModelId;
  /** Surfaced for the 8 GB low-memory warning banner. */
  totalMemoryGB: number;
  /** One-shot hint from `settings.ts` migration (deleted on read). */
  migrationHint: LlmModelId | undefined;
  installed: LlmInstalledHit[];
  scanned: LlmScannedHit[];
}
interface LlmInstallSnapshot {
  id: number;
  kind: InstallKind;
  model: LlmModelId;
  mirror?: LlmMirror;
  state: InstallState;
  progress?: DownloadProgress;
  destPath?: string;
  error?: string;
}

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
  { id: '3b' },
  { id: '7b' },
  { id: '14b' },
];

// --- State ----------------------------------------------------------------

const currentStep = ref<1 | 2>(1);
const status = ref<SetupStatus | null>(null);
const statusError = ref<string | null>(null);

// Step 1
const selectedModel = ref<WhisperModelName>('base');
const scanAction = ref<ScanAction>('symlink');
const mirror = ref<WhisperMirror>('huggingface');
const task = ref<InstallSnapshot | null>(null);
const actionError = ref<string | null>(null);
let whisperPollTimer: ReturnType<typeof setInterval> | null = null;

// Step 2 (LLM)
const llmStatus = ref<LlmStatusResp | null>(null);
const selectedLlm = ref<LlmModelId>('7b');
const llmMirror = ref<LlmMirror>('huggingface');
const llmScanAction = ref<ScanAction>('symlink');
const llmTask = ref<LlmInstallSnapshot | null>(null);
const llmActionError = ref<string | null>(null);
let llmPollTimer: ReturnType<typeof setInterval> | null = null;

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

// --- Step 1 (Whisper) -----------------------------------------------------

async function pollWhisperTask(): Promise<void> {
  try {
    // h3 serializes a `null` return as an empty body when no Content-Type
    // is set, so `$fetch` can resolve to `undefined`. Normalize to `null`
    // so the `task.value !== null` guards downstream are reliable —
    // `undefined !== null` was passing the guard and crashing the
    // `task.value.model` read in `taskOwnsSelection`.
    const next = await $fetch<InstallSnapshot | null>('/api/desktop/whisper/install');
    task.value = next ?? null;
  } catch {
    /* keep last state */
  }
}

function startWhisperPolling(): void {
  if (whisperPollTimer !== null) return;
  whisperPollTimer = setInterval(() => {
    void pollWhisperTask().then(() => {
      if (task.value && task.value.state !== 'running') stopWhisperPolling();
    });
  }, 500);
}

function stopWhisperPolling(): void {
  if (whisperPollTimer !== null) {
    clearInterval(whisperPollTimer);
    whisperPollTimer = null;
  }
}

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
// Optional chaining + loose `==` so both `null` and `undefined` flunk
// the guard. `$fetch` of `/api/desktop/whisper/install` can resolve to
// `undefined` when no task has ever been started this session.
const taskOwnsSelection = computed<boolean>(
  () => task.value?.model === selectedModel.value,
);
const installFinished = computed<boolean>(
  () => taskOwnsSelection.value && task.value?.state === 'success',
);
const installFailed = computed<boolean>(
  () => taskOwnsSelection.value && task.value?.state === 'error',
);
const installCanceled = computed<boolean>(
  () => taskOwnsSelection.value && task.value?.state === 'canceled',
);
const installRunning = computed<boolean>(
  () => taskOwnsSelection.value && task.value?.state === 'running',
);

const progressPercent = computed<number>(() => {
  const p = task.value?.progress;
  if (!p || !p.bytesTotal) return 0;
  return Math.min(100, Math.floor((p.bytesDownloaded / p.bytesTotal) * 100));
});

async function startInstall(): Promise<void> {
  actionError.value = null;
  const useScanned = scannedMatch.value !== null && scanAction.value !== 'ignore';
  const kind: InstallKind = useScanned
    ? (scanAction.value as 'symlink' | 'copy')
    : 'download';

  const body: Record<string, unknown> = { kind, model: selectedModel.value };
  if (useScanned) body.srcPath = scannedMatch.value!.path;
  else body.mirror = mirror.value;

  try {
    task.value = await $fetch<InstallSnapshot>('/api/desktop/whisper/install', {
      method: 'POST',
      body,
    });
    if (task.value.state === 'running') startWhisperPolling();
    if (task.value.state === 'success') void loadStatus();
  } catch (e) {
    const err = e as { statusMessage?: string; message?: string };
    actionError.value = err.statusMessage ?? err.message ?? 'Install failed to start';
  }
}

async function cancelInstall(): Promise<void> {
  try {
    await $fetch('/api/desktop/whisper/install', { method: 'DELETE' });
  } catch {
    /* surface via next poll */
  }
}

// --- Step 2 (LLM) ---------------------------------------------------------

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

/** Generation-aware guards — match the Whisper-side semantics. */
const llmTaskOwnsSelection = computed<boolean>(
  () => llmTask.value?.model === selectedLlm.value,
);
const llmInstallRunning = computed<boolean>(
  () => llmTaskOwnsSelection.value && llmTask.value?.state === 'running',
);
const llmInstallSucceeded = computed<boolean>(
  () => llmTaskOwnsSelection.value && llmTask.value?.state === 'success',
);
const llmInstallFailed = computed<boolean>(
  () => llmTaskOwnsSelection.value && llmTask.value?.state === 'error',
);
const llmInstallCanceled = computed<boolean>(
  () => llmTaskOwnsSelection.value && llmTask.value?.state === 'canceled',
);

const llmProgressPercent = computed<number>(() => {
  const p = llmTask.value?.progress;
  if (!p || !p.bytesTotal) return 0;
  return Math.min(100, Math.floor((p.bytesDownloaded / p.bytesTotal) * 100));
});

const lowMemoryWarning = computed<boolean>(
  // Show the banner when we know memory is below 8 GB. Default to false
  // (don't warn) when the status hasn't loaded yet to avoid a one-frame
  // flash on a fast-loading status response.
  () => (llmStatus.value?.totalMemoryGB ?? 999) < 8,
);

async function pollLlmTask(): Promise<void> {
  try {
    // Same `undefined`-normalisation rationale as `pollWhisperTask`.
    const next = await $fetch<LlmInstallSnapshot | null>('/api/desktop/llm/install');
    llmTask.value = next ?? null;
  } catch {
    /* keep last state */
  }
}

function startLlmPolling(): void {
  if (llmPollTimer !== null) return;
  llmPollTimer = setInterval(() => {
    void pollLlmTask().then(() => {
      if (llmTask.value && llmTask.value.state !== 'running') {
        stopLlmPolling();
        if (llmTask.value.state === 'success') void loadLlmStatus();
      }
    });
  }, 500);
}

function stopLlmPolling(): void {
  if (llmPollTimer !== null) {
    clearInterval(llmPollTimer);
    llmPollTimer = null;
  }
}

async function startLlmInstall(): Promise<void> {
  llmActionError.value = null;
  const scanned = scannedLlmFor(selectedLlm.value);
  const useScanned = scanned !== null && llmScanAction.value !== 'ignore';
  const kind: InstallKind = useScanned
    ? (llmScanAction.value as 'symlink' | 'copy')
    : 'download';

  const body: Record<string, unknown> = { kind, model: selectedLlm.value };
  if (useScanned) body.srcPath = scanned!.path;
  else body.mirror = llmMirror.value;

  try {
    llmTask.value = await $fetch<LlmInstallSnapshot>('/api/desktop/llm/install', {
      method: 'POST',
      body,
    });
    if (llmTask.value.state === 'running') startLlmPolling();
    if (llmTask.value.state === 'success') void loadLlmStatus();
  } catch (e) {
    const err = e as { statusMessage?: string; message?: string };
    llmActionError.value = err.statusMessage ?? err.message ?? 'Install failed to start';
  }
}

async function cancelLlmInstall(): Promise<void> {
  try {
    await $fetch('/api/desktop/llm/install', { method: 'DELETE' });
  } catch {
    /* surface via next poll */
  }
}

/**
 * Same idea as `pickWhisperDefault`: prefer the largest model already
 * canonically installed → the largest available externally (so
 * symlink/copy is one click away) → the migration-hint from the legacy
 * `ollamaModel` field if present → finally the server's hardware-tier
 * recommendation.
 */
function pickLlmDefault(): LlmModelId {
  const order: LlmModelId[] = ['14b', '7b', '3b'];
  for (const id of order) if (installedLlmIds.value.has(id)) return id;
  for (const id of order) if (scannedLlmFor(id) !== null) return id;
  if (llmStatus.value?.migrationHint) return llmStatus.value.migrationHint;
  return llmStatus.value?.recommended ?? '7b';
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
    await pollLlmTask();
    if (llmTask.value?.state === 'running') startLlmPolling();
  } else {
    stopLlmPolling();
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
  await Promise.all([loadStatus(), loadLlmStatus()]);
  await pollWhisperTask();
  if (task.value?.state === 'running') startWhisperPolling();

  // Default to the most useful Whisper model based on what's already
  // on disk — largest installed → largest reusable → base.
  if (status.value) selectedModel.value = pickWhisperDefault();
  if (llmStatus.value) selectedLlm.value = pickLlmDefault();

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
  if (status.value.hasWhisperModel && hasAnyLlm) {
    await navigateTo('/', { replace: true });
    return;
  }
  if (status.value.hasWhisperModel) {
    await enterStep(2);
  }
});

onBeforeUnmount(() => {
  stopWhisperPolling();
  stopLlmPolling();
});

// --- Navigation -----------------------------------------------------------

const canAdvanceStep1 = computed<boolean>(() => {
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
 * Persist the currently-selected Whisper / LLM model to user settings
 * when advancing past the relevant step. Without this, first-boot
 * defaults (set by hardware tier in `01.first-boot.ts`) win and the
 * transcribe handler later looks for a model the wizard never
 * actually installed — yielding "Model not downloaded" mid-flow.
 */
async function persistWhisperChoice(): Promise<void> {
  try {
    await $fetch('/api/settings', {
      method: 'PUT',
      body: { whisperModel: selectedModel.value },
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

function formatBytes(n: number | null): string {
  if (n === null) return '?';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} KB`;
  return `${n} B`;
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

      <!-- ===== Step 1 — Whisper ===== -->
      <template v-if="currentStep === 1">
        <section v-if="status" class="space-y-3">
          <div
            v-for="m in MODELS"
            :key="m.id"
            class="card-compact transition-colors"
            :class="selectedModel === m.id ? 'border-primary/50 bg-accent/30' : 'hover:bg-accent/20'"
          >
            <label class="flex cursor-pointer items-center gap-3">
              <input
                v-model="selectedModel"
                type="radio"
                :value="m.id"
                :disabled="installRunning"
                class="h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
              <span class="font-medium">ggml-{{ m.id }}.bin</span>
              <Badge v-if="status?.recommendedWhisperModel === m.id" variant="secondary">{{ t('desktop.setupWizard.recommended') }}</Badge>
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
                    v-model="scanAction"
                    type="radio"
                    value="symlink"
                    :disabled="installRunning"
                    class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                  <span>{{ t('desktop.setupWizard.actionSymlink') }}</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input
                    v-model="scanAction"
                    type="radio"
                    value="copy"
                    :disabled="installRunning"
                    class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                  <span>{{ t('desktop.setupWizard.actionCopy') }}</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input
                    v-model="scanAction"
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
              v-model="mirror"
              type="checkbox"
              :true-value="'hf-mirror'"
              :false-value="'huggingface'"
              :disabled="installRunning"
              class="size-4 accent-primary"
            >
            <i18n-t keypath="desktop.setupWizard.mirrorToggle" tag="span">
              <template #host><code class="font-mono">hf-mirror.com</code></template>
            </i18n-t>
          </label>
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
              {{ formatBytes(task.progress.bytesDownloaded) }} /
              {{ formatBytes(task.progress.bytesTotal) }} ·
              {{ formatBytes(Math.round(task.progress.bytesPerSecond)) }}{{ t('desktop.setupWizard.perSecond') }} ·
              {{ formatEta(task.progress.etaSeconds) }}
            </p>
            <span v-else />
            <Button variant="outline" size="sm" class="shrink-0" @click="cancelInstall">
              <XIcon class="h-3.5 w-3.5" />
              {{ t('desktop.setupWizard.cancel') }}
            </Button>
          </div>
        </section>

        <section
          v-if="installFinished"
          class="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {{ t('desktop.setupWizard.installedAt', { name: `ggml-${task!.model}.bin` }) }}
            <span class="font-mono text-xs">{{ task!.destPath }}</span>
          </span>
        </section>

        <section
          v-if="installFailed"
          class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t('desktop.setupWizard.installFailed', { error: task!.error }) }}</span>
        </section>

        <section
          v-if="installCanceled"
          class="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          <span>{{ t('desktop.setupWizard.installCanceled') }}</span>
        </section>

        <div v-if="actionError" class="text-sm text-destructive">{{ actionError }}</div>
      </template>

      <!-- ===== Step 2 — LLM (Qwen 2.5 GGUF) ===== -->
      <template v-else-if="currentStep === 2">
        <section
          v-if="lowMemoryWarning"
          class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
        >
          {{ t('desktop.llm.lowMemoryWarning') }}
        </section>

        <section v-if="llmStatus" class="space-y-3">
          <div
            v-for="m in LLM_TIERS"
            :key="m.id"
            class="card-compact transition-colors"
            :class="selectedLlm === m.id ? 'border-primary/50 bg-accent/30' : 'hover:bg-accent/20'"
          >
            <label class="flex cursor-pointer items-center gap-3">
              <input
                v-model="selectedLlm"
                type="radio"
                :value="m.id"
                :disabled="llmInstallRunning"
                class="h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
              <span class="font-medium font-mono">{{ LLM_MODELS[m.id].filename }}</span>
              <Badge v-if="llmStatus?.recommended === m.id" variant="secondary">{{ t('desktop.setupWizard.recommended') }}</Badge>
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
              <span class="ml-auto text-sm text-muted-foreground">{{ formatBytes(LLM_MODELS[m.id].sizeBytes) }}</span>
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
                    v-model="llmScanAction"
                    type="radio"
                    value="symlink"
                    :disabled="llmInstallRunning"
                    class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                  <span>{{ t('desktop.setupWizard.actionSymlink') }}</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input
                    v-model="llmScanAction"
                    type="radio"
                    value="copy"
                    :disabled="llmInstallRunning"
                    class="h-3 w-3 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[4px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                  <span>{{ t('desktop.setupWizard.actionCopy') }}</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input
                    v-model="llmScanAction"
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
              v-model="llmMirror"
              type="checkbox"
              :true-value="'hf-mirror'"
              :false-value="'huggingface'"
              :disabled="llmInstallRunning"
              class="size-4 accent-primary"
            >
            <i18n-t keypath="desktop.setupWizard.mirrorToggle" tag="span">
              <template #host><code class="font-mono">hf-mirror.com</code></template>
            </i18n-t>
          </label>
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
              {{ formatBytes(llmTask.progress.bytesDownloaded) }} /
              {{ formatBytes(llmTask.progress.bytesTotal) }} ·
              {{ formatBytes(Math.round(llmTask.progress.bytesPerSecond)) }}{{ t('desktop.setupWizard.perSecond') }} ·
              {{ formatEta(llmTask.progress.etaSeconds) }}
            </p>
            <span v-else />
            <Button variant="outline" size="sm" class="shrink-0" @click="cancelLlmInstall">
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
          v-if="llmInstallFailed"
          class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t('desktop.llm.installFailed', { error: llmTask!.error }) }}</span>
        </section>

        <section
          v-if="llmInstallCanceled"
          class="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
          <span>{{ t('desktop.setupWizard.installCanceled') }}</span>
        </section>

        <div v-if="llmActionError" class="text-sm text-destructive">{{ llmActionError }}</div>
      </template>

      <!-- ===== Footer ===== -->
      <div class="flex items-center justify-between border-t border-border pt-6">
        <div class="flex items-center gap-3">
          <NuxtLink to="/" class="text-sm text-muted-foreground hover:text-foreground">{{ t('desktop.setupWizard.skip') }}</NuxtLink>
          <Button
            v-if="currentStep > 1"
            variant="outline"
            size="sm"
            @click="goPrevStep"
          >
            <ChevronLeft class="h-4 w-4" />
            {{ t('desktop.setupWizard.back') }}
          </Button>
        </div>
        <div class="flex gap-2">
          <!-- Step 1 primary action — hide while a download is mid-flight
               so the page only ever shows ONE primary CTA. Cancel lives
               inside the progress card. -->
          <Button
            v-if="currentStep === 1 && !installFinished && !installedMatch && !installRunning"
            :disabled="!status"
            @click="startInstall"
          >
            {{ scannedMatch && scanAction !== 'ignore'
              ? (scanAction === 'symlink'
                ? t('desktop.setupWizard.linkExisting')
                : t('desktop.setupWizard.copyExisting'))
              : t('desktop.setupWizard.download') }}
          </Button>
          <!-- Forward navigation -->
          <Button
            v-if="currentStep === 1"
            :disabled="!canAdvanceStep1"
            @click="goNextStep"
          >
            {{ t('desktop.setupWizard.next') }}
            <ChevronRight class="h-4 w-4" />
          </Button>
          <!-- Step 2 primary action — install only when the selected
               tier isn't already installed and no install is in-flight. -->
          <Button
            v-if="currentStep === 2 && !llmInstallSucceeded && !installedLlmIds.has(selectedLlm) && !llmInstallRunning"
            :disabled="!llmStatus"
            @click="startLlmInstall"
          >
            {{ scannedLlmFor(selectedLlm) && llmScanAction !== 'ignore'
              ? (llmScanAction === 'symlink'
                ? t('desktop.setupWizard.linkExisting')
                : t('desktop.setupWizard.copyExisting'))
              : t('desktop.setupWizard.download') }}
          </Button>
          <Button
            v-if="currentStep === 2"
            :disabled="!canFinish"
            @click="goNextStep"
          >{{ t('desktop.setupWizard.finish') }}</Button>
        </div>
      </div>
    </div>
  </AppShell>
</template>
