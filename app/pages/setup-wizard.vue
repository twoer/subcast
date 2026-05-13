<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
/**
 * First-run setup wizard.
 *
 *   Step 1 — Whisper transcription model: pick a tier and install
 *            (symlink existing file / copy / download from HF).
 *   Step 2 — Qwen language model (Phase 2.7).
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

const { t } = useI18n();

// --- Types ----------------------------------------------------------------

// The setup-wizard's choices are a curated subset of WHISPER_MODEL_NAMES
// (the wizard intentionally omits large-v3 in favor of large-v3-turbo as
// the high-end pick). The type still uses the canonical union so a future
// addition to WHISPER_MODEL_NAMES surfaces here as a type error if the
// wizard should adopt it.
import type { WhisperModelName as CanonicalWhisperModelName } from '#shared/whisperModels';
type WhisperModelName = Extract<
  CanonicalWhisperModelName,
  'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo'
>;
type WhisperMirror = 'huggingface' | 'hf-mirror';
type InstallKind = 'symlink' | 'copy' | 'download';
type InstallState = 'running' | 'success' | 'error' | 'canceled';
type ScanAction = 'symlink' | 'copy' | 'ignore';
type QwenVariant = '3b' | '7b' | '14b';
type QwenPullState = 'running' | 'success' | 'error';

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
  recommendedOllamaModel: string;
  ollamaRunning: boolean;
  hasQwen: boolean;
  qwenModels: string[];
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
interface QwenPullProgress {
  status: string;
  digest?: string;
  completed?: number;
  total?: number;
}
interface QwenPullSnapshot {
  id: number;
  variant: QwenVariant;
  tag: string;
  state: QwenPullState;
  progress?: QwenPullProgress;
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

const QWEN_VARIANTS: Array<{ id: QwenVariant; tag: string; sizeLabel: string; recommended?: boolean }> = [
  { id: '3b', tag: 'qwen2.5:3b', sizeLabel: '1.9 GB' },
  { id: '7b', tag: 'qwen2.5:7b', sizeLabel: '4.7 GB', recommended: true },
  { id: '14b', tag: 'qwen2.5:14b', sizeLabel: '9.0 GB' },
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

// Step 2 (transitional — Qwen-pull markup remains until Task 4.2 swaps in
// the LLM picker; `selectedQwen` / `qwenTask` become `selectedLlm` /
// `llmTask` then).
const selectedQwen = ref<QwenVariant>('7b');
const qwenTask = ref<QwenPullSnapshot | null>(null);
const qwenActionError = ref<string | null>(null);
let qwenPollTimer: ReturnType<typeof setInterval> | null = null;

// --- Status fetch ---------------------------------------------------------

async function loadStatus(): Promise<void> {
  statusError.value = null;
  try {
    status.value = await $fetch<SetupStatus>('/api/desktop/setup-status');
  } catch (e) {
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

// --- Step 2 (Qwen) --------------------------------------------------------

const installedQwen = computed<Set<QwenVariant>>(() => {
  const installed = new Set<QwenVariant>();
  for (const tag of status.value?.qwenModels ?? []) {
    for (const v of QWEN_VARIANTS) {
      if (tag === v.tag) installed.add(v.id);
    }
  }
  return installed;
});

const qwenAlreadyInstalled = computed<boolean>(
  () => installedQwen.value.has(selectedQwen.value),
);

// Optional chaining so both `null` and `undefined` flunk the guard —
// `$fetch` of `/api/desktop/qwen/pull` resolves to `undefined` when no
// task has been started (h3 returns null → empty body → undefined).
// A `!== null` check let undefined through and the next `.variant`
// read threw, which interrupted v-model patching on the radios in
// the v-for above (rendering all three as "selected").
const qwenPullRunning = computed<boolean>(
  () => qwenTask.value?.variant === selectedQwen.value
    && qwenTask.value?.state === 'running',
);

const qwenPullFinished = computed<boolean>(
  () => qwenTask.value?.variant === selectedQwen.value
    && qwenTask.value?.state === 'success',
);

const qwenPullFailed = computed<boolean>(
  () => qwenTask.value?.variant === selectedQwen.value
    && qwenTask.value?.state === 'error',
);

const qwenProgressPercent = computed<number>(() => {
  const p = qwenTask.value?.progress;
  if (!p || !p.total) return 0;
  return Math.min(100, Math.floor(((p.completed ?? 0) / p.total) * 100));
});

async function pollQwenTask(): Promise<void> {
  try {
    const next = await $fetch<QwenPullSnapshot | null>('/api/desktop/qwen/pull');
    qwenTask.value = next ?? null;
  } catch {
    /* keep last */
  }
}

function startQwenPolling(): void {
  if (qwenPollTimer !== null) return;
  qwenPollTimer = setInterval(() => {
    void pollQwenTask().then(() => {
      if (qwenTask.value && qwenTask.value.state !== 'running') {
        stopQwenPolling();
        if (qwenTask.value.state === 'success') void loadStatus();
      }
    });
  }, 500);
}

function stopQwenPolling(): void {
  if (qwenPollTimer !== null) {
    clearInterval(qwenPollTimer);
    qwenPollTimer = null;
  }
}

async function startQwenPull(): Promise<void> {
  qwenActionError.value = null;
  try {
    qwenTask.value = await $fetch<QwenPullSnapshot>('/api/desktop/qwen/pull', {
      method: 'POST',
      body: { variant: selectedQwen.value },
    });
    if (qwenTask.value.state === 'running') startQwenPolling();
    if (qwenTask.value.state === 'success') void loadStatus();
  } catch (e) {
    const err = e as { statusMessage?: string; message?: string };
    qwenActionError.value = err.statusMessage ?? err.message ?? 'Pull failed to start';
  }
}

async function cancelQwenPull(): Promise<void> {
  try {
    await $fetch('/api/desktop/qwen/pull', { method: 'DELETE' });
  } catch {
    /* surface via next poll */
  }
}

/** Default-select the largest installed variant; fall back to recommended. */
function pickQwenDefault(): QwenVariant {
  for (const v of ['14b', '7b', '3b'] as const) {
    if (installedQwen.value.has(v)) return v;
  }
  return '7b';
}

/**
 * Same idea as `pickQwenDefault`: prefer the largest model already
 * canonically installed, then the largest available externally (so
 * symlink/copy is one click away), then fall back to whatever the
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
    selectedQwen.value = pickQwenDefault();
    await pollQwenTask();
    if (qwenTask.value?.state === 'running') startQwenPolling();
  } else {
    stopQwenPolling();
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
  await loadStatus();
  await pollWhisperTask();
  if (task.value?.state === 'running') startWhisperPolling();

  // Default to the most useful Whisper model based on what's already
  // on disk — largest installed → largest reusable → base.
  if (status.value) selectedModel.value = pickWhisperDefault();

  // `?step=1|2` from Settings → Models "Download more" buttons forces
  // landing on that step even when first-run setup is fully complete —
  // otherwise the auto-redirect below would bounce the user home.
  const forcedStep = Number(route.query.step);
  if (forcedStep === 1 || forcedStep === 2) {
    await enterStep(forcedStep);
    return;
  }

  // First-run flow: resume from earliest unmet step, or fast-forward home
  // if every dependency is already satisfied.
  if (!status.value) return;
  if (status.value.hasWhisperModel && status.value.hasQwen) {
    await navigateTo('/', { replace: true });
    return;
  }
  if (status.value.hasWhisperModel) {
    await enterStep(2);
  }
});

onBeforeUnmount(() => {
  stopWhisperPolling();
  stopQwenPolling();
});

// --- Navigation -----------------------------------------------------------

const canAdvanceStep1 = computed<boolean>(() => {
  // Selected model is already canonically installed — no further action.
  if (installedMatch.value !== null) return true;
  // Or we just finished installing the selected model this session.
  return installFinished.value;
});

const canFinish = computed<boolean>(
  () => qwenAlreadyInstalled.value || qwenPullFinished.value,
);

/**
 * Persist the currently-selected Whisper / Qwen model to user settings
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

async function persistQwenChoice(): Promise<void> {
  try {
    const tag = QWEN_VARIANTS.find((v) => v.id === selectedQwen.value)?.tag;
    if (tag) {
      await $fetch('/api/settings', {
        method: 'PUT',
        body: { ollamaModel: tag },
      });
    }
  } catch { /* see persistWhisperChoice */ }
}

async function goNextStep(): Promise<void> {
  if (currentStep.value === 1 && canAdvanceStep1.value) {
    await persistWhisperChoice();
    await enterStep(2);
  } else if (currentStep.value === 2) {
    await persistQwenChoice();
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
              t('desktop.setupWizard.stepLabel3'),
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
          <template v-else>{{ t('desktop.setupWizard.subtitleStep3') }}</template>
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
                {{ t('desktop.qwen.alreadyInstalled') }}
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

      <!-- ===== Step 2 — Qwen (transitional; LLM picker in Task 4.2) ===== -->
      <template v-else-if="currentStep === 2">
        <section class="space-y-3">
          <div
            v-for="v in QWEN_VARIANTS"
            :key="v.id"
            class="card-compact transition-colors"
            :class="selectedQwen === v.id ? 'border-primary/50 bg-accent/30' : 'hover:bg-accent/20'"
          >
            <label class="flex cursor-pointer items-center gap-3">
              <input
                v-model="selectedQwen"
                type="radio"
                :value="v.id"
                :disabled="qwenPullRunning"
                class="h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-input bg-background ring-offset-background checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
              <span class="font-medium font-mono">{{ v.tag }}</span>
              <Badge v-if="v.recommended" variant="secondary">{{ t('desktop.setupWizard.recommended') }}</Badge>
              <span
                v-if="installedQwen.has(v.id)"
                class="inline-flex items-center gap-1 text-xs text-success"
              >
                <CheckCircle2 class="h-3.5 w-3.5" />
                {{ t('desktop.qwen.alreadyInstalled') }}
              </span>
              <span class="ml-auto text-sm text-muted-foreground">{{ v.sizeLabel }}</span>
            </label>
          </div>
        </section>

        <section
          v-if="qwenTask && qwenPullRunning"
          class="card-compact space-y-3"
        >
          <p class="text-sm font-medium">
            {{ t('desktop.qwen.pullingPrefix', { tag: qwenTask.tag, status: qwenTask.progress?.status ?? t('desktop.qwen.pullingStarting') }) }}
          </p>
          <Progress :model-value="qwenProgressPercent" />
          <p v-if="qwenTask.progress?.total" class="text-xs text-muted-foreground">
            {{ formatBytes(qwenTask.progress.completed ?? 0) }} /
            {{ formatBytes(qwenTask.progress.total) }}
          </p>
          <Button variant="outline" size="sm" @click="cancelQwenPull">{{ t('desktop.setupWizard.cancel') }}</Button>
        </section>

        <section
          v-if="qwenAlreadyInstalled || qwenPullFinished"
          class="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
        >
          <CheckCircle2 class="h-4 w-4 shrink-0" />
          {{ t('desktop.qwen.ready', { tag: QWEN_VARIANTS.find((v) => v.id === selectedQwen)?.tag ?? '' }) }}
        </section>

        <section
          v-if="qwenPullFailed"
          class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t('desktop.qwen.pullFailed', { error: qwenTask!.error }) }}</span>
        </section>

        <div v-if="qwenActionError" class="text-sm text-destructive">{{ qwenActionError }}</div>
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
          <!-- Step 2 primary action -->
          <Button
            v-if="currentStep === 2 && !qwenAlreadyInstalled && !qwenPullFinished"
            :disabled="qwenPullRunning"
            @click="startQwenPull"
          >{{ t('desktop.qwen.pull', { tag: QWEN_VARIANTS.find((v) => v.id === selectedQwen)?.tag ?? '' }) }}</Button>
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
