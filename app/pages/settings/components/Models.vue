<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Models tab for the settings page (desktop-only).
 *
 * State split with the page:
 *   - draft / settings  → v-model with parent (the page shares these
 *     with the Preferences tab too, so the page owns the authoritative
 *     copy and we expose two-way bindings).
 *   - hardware / saving / savedAt → read-only props from parent.
 *   - modelsData / pendingDelete / modelsErr  → private to this tab;
 *     no other tab cares about them.
 *
 * Saves: direct "Switch" / "Delete" calls hit /api/* themselves and
 * write back to settings/draft via the v-model. The "Save active
 * models" button at the bottom emits `save` so the parent's shared
 * `saveSlice` (which also tracks saving / savedAt for both tabs)
 * handles the actual PUT — keeps the saving / savedAt UX consistent
 * with the Preferences tab.
 */

import type { Component } from 'vue';
import {
  Activity, Plus, Boxes, RefreshCw, Trash2, AlertTriangle, CheckCircle2, Languages, Sparkles, WandSparkles,
} from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WHISPER_MODEL_NAMES } from '#shared/whisperModels';
import { LLM_MODELS, isLlmModelId, llmDisplayName, type LlmModelId, type LlmTaskKind } from '#shared/llmModels';
import { Badge } from '~/components/ui/badge';
import { fmtBytes } from '~/utils/format';
import type { Settings, Hardware, TranscribeEngine } from '@/types/settings';
import type { LlmTaskPolicyDecision } from '@/types/setupWizard';

const draft = defineModel<Settings | null>('draft', { required: true });
const settings = defineModel<Settings | null>('settings', { required: true });

const props = defineProps<{
  hardware: Hardware | null;
  saving: boolean;
  savedAt: number | null;
}>();

const emit = defineEmits<{
  (e: 'save'): void;
}>();

interface WhisperModelRow { name: string; sizeBytes: number }
interface LlmModelRow { name: LlmModelId; filename: string; sizeBytes: number }
interface LegacyLlmRow { filename: string; sizeBytes: number }
type LlmRuntimeState = 'idle' | 'starting' | 'running' | 'stopping';
interface LlmRuntimeSnapshot {
  state: LlmRuntimeState;
  modelId: string | null;
  runtimeProfileId: string | null;
  idleShutdownMs: number;
  idleDeadlineAt: number | null;
  activeRequests?: number;
}
interface TranscribeRuntimeSnapshot {
  state: LlmRuntimeState;
  activeTasks: number;
  engines: string[];
  whisper?: {
    state: LlmRuntimeState;
    idleShutdownMs: number;
    idleDeadlineAt: number | null;
  };
}
interface ModelsResp {
  transcribeEngine?: TranscribeEngine;
  transcribeRuntime?: TranscribeRuntimeSnapshot;
  whisper: { active: string; installed: WhisperModelRow[] };
  sensevoice?: { ready: boolean };
  llm: {
    active: LlmModelId | undefined;
    runtime?: LlmRuntimeSnapshot;
    installed: LlmModelRow[];
    needsDownload?: boolean;
    taskPolicies?: LlmTaskPolicyDecision[];
    legacy?: LegacyLlmRow[];
  };
}
type DeleteTarget =
  | { kind: 'whisper'; name: string; sizeBytes: number }
  | { kind: 'llm'; name: LlmModelId; sizeBytes: number }
  | { kind: 'legacyLlm'; name: string; sizeBytes: number };

interface LlmInstallSnapshot {
  id: number;
  kind: string;
  model: LlmModelId;
  state: 'running' | 'success' | 'error' | 'canceled';
  progress?: { bytesDownloaded: number; bytesTotal: number | null };
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface SenseVoiceInstallSnapshot {
  id: number;
  kind: 'download';
  state: 'running' | 'success' | 'error' | 'canceled';
  progress?: { bytesDownloaded: number; bytesTotal: number | null };
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const { t } = useI18n();
const { set: setActiveModelsCache, refresh: refreshActiveModels } = useActiveModels();

const WHISPER_MODELS = WHISPER_MODEL_NAMES;
const LLM_MODEL_IDS = Object.keys(LLM_MODELS) as LlmModelId[];
type UserFacingLlmTask = Extract<LlmTaskKind, 'translate' | 'polish' | 'insight'>;
type UserFacingLlmTaskPolicy = LlmTaskPolicyDecision & { task: UserFacingLlmTask };
const USER_FACING_LLM_TASKS = ['translate', 'polish', 'insight'] as const satisfies readonly UserFacingLlmTask[];
const LLM_TASK_ICONS: Record<UserFacingLlmTask, Component> = {
  translate: Languages,
  polish: WandSparkles,
  insight: Sparkles,
};

const modelsData = ref<ModelsResp | null>(null);
const modelsLoading = ref(false);
const modelsErr = ref<string | null>(null);
const pendingDelete = ref<DeleteTarget | null>(null);
let modelsRequestInFlight = false;
let modelsRefreshTimer: ReturnType<typeof setInterval> | null = null;

// SenseVoice install state (download-only, single fixed model).
const svInstall = ref<SenseVoiceInstallSnapshot | null>(null);
let svPollTimer: ReturnType<typeof setInterval> | null = null;

// LLM re-download state (Qwen3 upgrade guidance: active tier file missing).
const llmInstall = ref<LlmInstallSnapshot | null>(null);
let llmPollTimer: ReturnType<typeof setInterval> | null = null;

const runtimeNow = ref(Date.now());
let runtimeClockTimer: ReturnType<typeof setInterval> | null = null;

const llmNeedsDownload = computed(() => modelsData.value?.llm.needsDownload === true);
const transcribeRuntime = computed(() => modelsData.value?.transcribeRuntime ?? null);
const llmRuntime = computed(() => modelsData.value?.llm.runtime ?? null);
const transcribeRuntimeCountdownMs = computed(() => {
  const deadline = transcribeRuntime.value?.whisper?.idleDeadlineAt;
  if (!deadline) return null;
  return Math.max(0, deadline - runtimeNow.value);
});
const transcribeRuntimeEngineLabel = computed(() => {
  const engine = transcribeRuntime.value?.engines[0];
  if (engine === 'whisper' || engine === 'sensevoice' || engine === 'auto') return engineName(engine);
  return engine || engineName(draft.value?.transcribeEngine ?? 'auto');
});
const transcribeRuntimeStateLabel = computed(() => {
  const runtime = transcribeRuntime.value;
  if (!runtime || runtime.state === 'idle') return t('settings.models.runtimeIdle');
  if (runtime.state === 'starting') return t('settings.models.runtimeStarting');
  if (runtime.state === 'stopping') return t('settings.models.runtimeStopping');
  if (runtime.activeTasks > 0) return t('settings.models.runtimeActive');
  return t('settings.models.runtimeRunning');
});
const transcribeRuntimeBadgeVariant = computed(() => {
  const state = transcribeRuntime.value?.state ?? 'idle';
  if (state === 'running') return 'active';
  if (state === 'idle') return 'outline';
  return 'secondary';
});
const transcribeRuntimeDetail = computed(() => {
  const runtime = transcribeRuntime.value;
  if (!runtime || runtime.state === 'idle') return t('settings.models.transcribeRuntimeIdleDetail');
  if (runtime.activeTasks > 0) {
    return t('settings.models.transcribeRuntimeActiveDetail', {
      engine: transcribeRuntimeEngineLabel.value,
      count: runtime.activeTasks,
    });
  }
  if (runtime.state === 'starting') return t('settings.models.transcribeRuntimeStartingDetail');
  if (runtime.state === 'stopping') return t('settings.models.transcribeRuntimeStoppingDetail');
  const countdownMs = transcribeRuntimeCountdownMs.value;
  if (countdownMs !== null) {
    return t('settings.models.transcribeRuntimeAutoRelease', {
      engine: transcribeRuntimeEngineLabel.value,
      duration: formatRuntimeDuration(countdownMs),
    });
  }
  return t('settings.models.transcribeRuntimeRunningDetail', {
    engine: transcribeRuntimeEngineLabel.value,
  });
});
const llmRuntimeModelName = computed(() => {
  const runtimeModel = llmRuntime.value?.modelId;
  if (isLlmModelId(runtimeModel)) return llmDisplayName(runtimeModel);
  const configuredModel = draft.value?.llmModel;
  return configuredModel ? llmDisplayName(configuredModel) : t('settings.models.notConfigured');
});
const llmRuntimeCountdownMs = computed(() => {
  const deadline = llmRuntime.value?.idleDeadlineAt;
  if (!deadline) return null;
  return Math.max(0, deadline - runtimeNow.value);
});
const llmRuntimeStateLabel = computed(() => {
  const state = llmRuntime.value?.state ?? 'idle';
  if (state === 'starting') return t('settings.models.runtimeStarting');
  if (state === 'running') {
    return (llmRuntime.value?.activeRequests ?? 0) > 0
      ? t('settings.models.runtimeActive')
      : t('settings.models.runtimeRunning');
  }
  if (state === 'stopping') return t('settings.models.runtimeStopping');
  return t('settings.models.runtimeIdle');
});
const llmRuntimeBadgeVariant = computed(() => {
  const state = llmRuntime.value?.state ?? 'idle';
  if (state === 'running') return 'active';
  if (state === 'idle') return 'outline';
  return 'secondary';
});
const llmRuntimeDetail = computed(() => {
  const runtime = llmRuntime.value;
  if (!runtime || runtime.state === 'idle') return t('settings.models.runtimeIdleDetail');
  if (runtime.state === 'starting') {
    return t('settings.models.runtimeStartingDetail', { model: llmRuntimeModelName.value });
  }
  if (runtime.state === 'stopping') return t('settings.models.runtimeStoppingDetail');
  if ((runtime.activeRequests ?? 0) > 0) {
    return t('settings.models.runtimeActiveDetail', { model: llmRuntimeModelName.value });
  }
  const countdownMs = llmRuntimeCountdownMs.value;
  if (countdownMs !== null) {
    return t('settings.models.runtimeAutoRelease', {
      model: llmRuntimeModelName.value,
      duration: formatRuntimeDuration(countdownMs),
    });
  }
  return t('settings.models.runtimeRunningDetail', { model: llmRuntimeModelName.value });
});
const llmTaskPolicyRows = computed<UserFacingLlmTaskPolicy[]>(() => {
  const policies = modelsData.value?.llm.taskPolicies ?? [];
  return USER_FACING_LLM_TASKS.flatMap((task) => {
    const policy = policies.find((p): p is UserFacingLlmTaskPolicy => p.task === task);
    return policy ? [policy] : [];
  });
});
const legacyLlmFiles = computed(() => modelsData.value?.llm.legacy ?? []);
const legacyLlmTotal = computed(() =>
  legacyLlmFiles.value.reduce((sum, f) => sum + f.sizeBytes, 0),
);

const ENGINE_OPTIONS: ReadonlyArray<{ id: TranscribeEngine }> = [
  { id: 'auto' },
  { id: 'sensevoice' },
  { id: 'whisper' },
];

/** User-facing engine name — brand casing for the engines, localized
 *  label for `auto`. Raw ids stay storage-only. */
function engineName(id: TranscribeEngine): string {
  if (id === 'auto') return t('app.engineAutoName');
  if (id === 'sensevoice') return 'SenseVoice';
  return 'Whisper';
}

function llmTaskPolicyLabel(task: UserFacingLlmTask): string {
  if (task === 'translate') return t('settings.models.taskPolicyTranslate');
  if (task === 'polish') return t('settings.models.taskPolicyPolish');
  return t('settings.models.taskPolicyInsight');
}

function formatRuntimeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return t('settings.models.runtimeDurationSeconds', { n: totalSeconds });
  }
  return t('settings.models.runtimeDurationMinutes', {
    m: Math.floor(totalSeconds / 60),
    s: totalSeconds % 60,
  });
}

const senseVoiceReady = computed(() => modelsData.value?.sensevoice?.ready ?? false);
const anyWhisperInstalled = computed(() => (modelsData.value?.whisper.installed.length ?? 0) > 0);
const engineHint = computed(() => {
  const engine = draft.value?.transcribeEngine;
  if (engine === 'sensevoice' && !senseVoiceReady.value) {
    return t('settings.models.sensevoiceNotInstalled');
  }
  if (engine === 'auto' && !senseVoiceReady.value && !anyWhisperInstalled.value) {
    return t('settings.models.noEngineInstalled');
  }
  return null;
});

const installedWhisperNames = computed<Set<string>>(
  () => new Set(modelsData.value?.whisper.installed.map((m) => m.name) ?? []),
);

const dirtyModels = computed(() => {
  if (!settings.value || !draft.value) return false;
  return (
    draft.value.whisperModel !== settings.value.whisperModel
    || draft.value.llmModel !== settings.value.llmModel
    || (draft.value.transcribeEngine ?? 'auto') !== (settings.value.transcribeEngine ?? 'auto')
  );
});

async function loadModels(opts: { silent?: boolean } = {}): Promise<void> {
  if (modelsRequestInFlight) return;
  modelsRequestInFlight = true;
  if (!opts.silent) {
    modelsLoading.value = true;
    modelsErr.value = null;
  }
  try {
    modelsData.value = await $fetch<ModelsResp>('/api/desktop/models');
  } catch (e) {
    if (!opts.silent) {
      modelsErr.value = e instanceof Error ? e.message : 'failed to load models';
    }
  } finally {
    modelsRequestInFlight = false;
    if (!opts.silent) {
      modelsLoading.value = false;
    }
  }
}

async function setActiveWhisper(name: string): Promise<void> {
  try {
    const res = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: { whisperModel: name },
    });
    settings.value = res.settings;
    draft.value = { ...res.settings };
    if (modelsData.value) modelsData.value.whisper.active = res.settings.whisperModel;
    setActiveModelsCache(res.settings.whisperModel, res.settings.llmModel, res.settings.transcribeEngine);
    void refreshActiveModels();
  } catch (e) {
    modelsErr.value = t('settings.models.switchFailed', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

async function setActiveLlm(name: LlmModelId): Promise<void> {
  try {
    const res = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: { llmModel: name },
    });
    settings.value = res.settings;
    draft.value = { ...res.settings };
    if (modelsData.value) modelsData.value.llm.active = name;
    setActiveModelsCache(res.settings.whisperModel, res.settings.llmModel, res.settings.transcribeEngine);
    void refreshActiveModels();
  } catch (e) {
    modelsErr.value = t('settings.models.switchFailed', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  pendingDelete.value = null;
  try {
    if (target.kind === 'legacyLlm') {
      const res = await $fetch<{ deleted: string[]; freedBytes: number }>(
        '/api/desktop/llm/legacy',
        { method: 'DELETE' },
      );
      if (res.deleted.length === 0) {
        modelsErr.value = t('settings.models.legacyLlmNone');
      }
      await loadModels();
      return;
    }
    const url =
      target.kind === 'whisper'
        ? `/api/desktop/whisper/${encodeURIComponent(target.name)}`
        : `/api/desktop/llm/${encodeURIComponent(target.name)}`;
    await $fetch(url, { method: 'DELETE' });
    await loadModels();
  } catch (e) {
    modelsErr.value = t('settings.models.deleteFailed', { error: e instanceof Error ? e.message : 'unknown' });
  }
}

function applyRecommended(): void {
  if (!draft.value || !props.hardware) return;
  draft.value.whisperModel = props.hardware.recommended.whisperModel as Settings['whisperModel'];
  draft.value.llmModel = props.hardware.recommended.llmModel;
}

// --- SenseVoice install ----------------------------------------------------

async function pollSenseVoiceInstall(): Promise<void> {
  try {
    const res = await $fetch<{ install: SenseVoiceInstallSnapshot | null }>(
      '/api/desktop/sensevoice/install',
    );
    svInstall.value = res.install;
    if (res.install && res.install.state === 'running') return;
  } catch {
    // Poll errors are non-fatal; next tick retries.
  }
  if (svPollTimer) {
    clearInterval(svPollTimer);
    svPollTimer = null;
  }
  await loadModels();
}

async function startSenseVoiceInstall(): Promise<void> {
  modelsErr.value = null;
  try {
    const res = await $fetch<SenseVoiceInstallSnapshot>('/api/desktop/sensevoice/install', {
      method: 'POST',
    });
    svInstall.value = res;
    if (res.state === 'running' && !svPollTimer) {
      svPollTimer = setInterval(() => { void pollSenseVoiceInstall(); }, 1000);
    }
  } catch (e) {
    modelsErr.value = t('settings.models.sensevoiceInstallFailed', {
      error: e instanceof Error ? e.message : 'unknown',
    });
  }
}

async function cancelSenseVoiceInstall(): Promise<void> {
  try {
    await $fetch('/api/desktop/sensevoice/install', { method: 'DELETE' });
  } catch {
    // Ignore — the poll loop will converge on the final state anyway.
  }
}

async function deleteSenseVoice(): Promise<void> {
  try {
    await $fetch('/api/desktop/sensevoice/model', { method: 'DELETE' });
    await loadModels();
  } catch (e) {
    modelsErr.value = t('settings.models.deleteFailed', {
      error: e instanceof Error ? e.message : 'unknown',
    });
  }
}

// --- Qwen3 upgrade guidance --------------------------------------------------

async function pollLlmInstall(): Promise<void> {
  try {
    const res = await $fetch<LlmInstallSnapshot | null>('/api/desktop/llm/install');
    llmInstall.value = res;
    if (res && res.state === 'running') return;
  } catch {
    // Non-fatal; next tick retries.
  }
  if (llmPollTimer) {
    clearInterval(llmPollTimer);
    llmPollTimer = null;
  }
  await loadModels();
}

async function downloadActiveLlm(): Promise<void> {
  const model = modelsData.value?.llm.active ?? draft.value?.llmModel;
  if (!model) return;
  modelsErr.value = null;
  try {
    const res = await $fetch<LlmInstallSnapshot>('/api/desktop/llm/install', {
      method: 'POST',
      body: { kind: 'download', model },
    });
    llmInstall.value = res;
    if (res.state === 'running' && !llmPollTimer) {
      llmPollTimer = setInterval(() => { void pollLlmInstall(); }, 1000);
    }
  } catch (e) {
    modelsErr.value = t('settings.models.sensevoiceInstallFailed', {
      error: e instanceof Error ? e.message : 'unknown',
    });
  }
}

async function deleteLegacyLlm(): Promise<void> {
  pendingDelete.value = { kind: 'legacyLlm', name: 'Qwen2.5', sizeBytes: legacyLlmTotal.value };
}

onBeforeUnmount(() => {
  if (modelsRefreshTimer) clearInterval(modelsRefreshTimer);
  if (svPollTimer) clearInterval(svPollTimer);
  if (llmPollTimer) clearInterval(llmPollTimer);
  if (runtimeClockTimer) clearInterval(runtimeClockTimer);
});

function resetActiveModelsDraft(): void {
  if (!draft.value || !settings.value) return;
  draft.value.whisperModel = settings.value.whisperModel;
  draft.value.llmModel = settings.value.llmModel;
  draft.value.transcribeEngine = settings.value.transcribeEngine;
}

onMounted(() => {
  void loadModels();
  modelsRefreshTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void loadModels({ silent: true });
  }, 5000);
  runtimeClockTimer = setInterval(() => {
    runtimeNow.value = Date.now();
  }, 1000);
});
</script>

<template>
  <div class="space-y-6">
    <Alert v-if="modelsErr" variant="destructive">
      <AlertDescription>{{ modelsErr }}</AlertDescription>
    </Alert>

    <section v-if="draft" class="card space-y-5">
      <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <CheckCircle2 class="h-3.5 w-3.5" />
        {{ t('settings.models.activeTitle') }}
      </h2>

      <div class="space-y-1.5">
        <Label class="text-sm font-medium">{{ t('settings.transcribeEngine') }}</Label>
        <Select v-model="draft.transcribeEngine">
          <SelectTrigger class="w-full">
            <!-- 显式插槽：SelectValue 默认取选中项 textContent，
                 会把选项里的徽标文字（如「中文更快」）一起带进触发器 -->
            <SelectValue>
              <span>{{ engineName(draft.transcribeEngine ?? 'auto') }}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="e in ENGINE_OPTIONS" :key="e.id" :value="e.id">
              <span>{{ engineName(e.id) }}</span>
              <span
                v-if="senseVoiceReady && e.id === 'sensevoice'"
                class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
              >{{ t('settings.models.sensevoiceFastCn') }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ t('settings.transcribeEngineHint') }}</p>
        <div
          v-if="transcribeRuntime"
          class="mt-3 rounded-md bg-accent/30 px-2 py-2"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="flex min-w-0 items-center gap-2 text-sm text-foreground">
              <Activity class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ t('settings.models.transcribeRuntimeTitle') }}</span>
            </span>
            <Badge
              :variant="transcribeRuntimeBadgeVariant"
              size="sm"
              class="shrink-0 uppercase tracking-wider"
            >
              {{ transcribeRuntimeStateLabel }}
            </Badge>
          </div>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ transcribeRuntimeDetail }}
          </p>
        </div>
        <Alert v-if="engineHint" variant="destructive" class="mt-2">
          <AlertTriangle class="h-4 w-4" />
          <AlertDescription>{{ engineHint }}</AlertDescription>
        </Alert>
      </div>

      <div v-if="draft.transcribeEngine !== 'sensevoice'" class="space-y-1.5">
        <Label class="text-sm font-medium">{{ t('settings.whisperModel') }}</Label>
        <Select v-model="draft.whisperModel">
          <SelectTrigger class="w-full">
            <SelectValue>
              <span class="font-mono">{{ draft.whisperModel }}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in WHISPER_MODELS" :key="m" :value="m">
              <span class="font-mono">{{ m }}</span>
              <span
                v-if="hardware && m === hardware.recommended.whisperModel"
                class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
              >{{ t('settings.recommended') }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">{{ t('settings.whisperHint') }}</p>
        <Alert
          v-if="modelsData && draft.transcribeEngine === 'whisper' && !installedWhisperNames.has(draft.whisperModel)"
          variant="destructive"
          class="mt-2"
        >
          <AlertTriangle class="h-4 w-4" />
          <AlertDescription>
            {{ t('settings.models.notInstalledWarn', { name: draft.whisperModel }) }}
          </AlertDescription>
        </Alert>
      </div>

      <div class="space-y-1.5">
        <Label class="text-sm font-medium">{{ t('settings.llmModel') }}</Label>
        <Select v-model="draft.llmModel">
          <SelectTrigger class="w-full">
            <SelectValue>
              <span v-if="draft.llmModel" class="font-mono">{{ llmDisplayName(draft.llmModel) }}</span>
              <span v-else class="text-muted-foreground">{{ t('settings.models.notConfigured') }}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="id in LLM_MODEL_IDS" :key="id" :value="id">
              <span class="font-mono">{{ llmDisplayName(id) }}</span>
              <span
                v-if="hardware && id === hardware.recommended.llmModel"
                class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
              >{{ t('settings.recommended') }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground">
          {{ t('settings.llmHint', { model: hardware?.recommended.llmModel ?? '' }) }}
        </p>

        <div
          v-if="llmNeedsDownload || llmRuntime || llmTaskPolicyRows.length > 0"
          class="mt-3 space-y-3 border-t border-border/50 pt-3"
        >
          <div
            v-if="llmRuntime"
            class="rounded-md bg-accent/30 px-2 py-2"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="flex min-w-0 items-center gap-2 text-sm text-foreground">
                <Activity class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="truncate">{{ t('settings.models.runtimeTitle') }}</span>
              </span>
              <Badge
                :variant="llmRuntimeBadgeVariant"
                size="sm"
                class="shrink-0 uppercase tracking-wider"
              >
                {{ llmRuntimeStateLabel }}
              </Badge>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ llmRuntimeDetail }}
            </p>
          </div>

          <Alert
            v-if="llmNeedsDownload && !(llmInstall && llmInstall.state === 'running')"
            variant="destructive"
          >
            <AlertTriangle class="h-4 w-4 shrink-0" />
            <AlertDescription class="flex items-center gap-3">
              <span class="flex-1">
                {{ t('settings.models.llmNeedsDownload', { model: modelsData?.llm.active ?? '' }) }}
              </span>
              <Button size="xs" @click="downloadActiveLlm">
                {{ t('settings.models.llmDownloadNow') }}
              </Button>
            </AlertDescription>
          </Alert>

          <div
            v-if="llmTaskPolicyRows.length > 0"
            class="space-y-1.5"
            :class="{ 'opacity-60': llmNeedsDownload }"
          >
            <div class="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('settings.models.taskPolicyTitle') }}
            </div>
            <div class="space-y-1">
              <div
                v-for="policy in llmTaskPolicyRows"
                :key="policy.task"
                class="flex items-center justify-between gap-3 rounded-md bg-accent/30 px-2 py-1.5"
              >
                <span class="flex min-w-0 items-center gap-2 text-sm text-foreground">
                  <component
                    :is="LLM_TASK_ICONS[policy.task]"
                    class="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span class="truncate">{{ llmTaskPolicyLabel(policy.task) }}</span>
                </span>
                <span class="inline-flex shrink-0 items-center gap-1.5">
                  <span class="font-mono text-xs text-muted-foreground">
                    {{ llmDisplayName(policy.modelId) }}
                  </span>
                  <Badge
                    v-if="policy.fallback"
                    variant="secondary"
                    size="sm"
                    class="uppercase tracking-wider"
                  >
                    <AlertTriangle class="h-3 w-3 shrink-0" />
                    {{ t('settings.models.taskPolicyFallback') }}
                  </Badge>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-3 border-t border-border/50 pt-4">
        <Button
          :disabled="!dirtyModels || saving"
          @click="emit('save')"
        >
          {{ saving ? t('settings.saving') : dirtyModels ? t('settings.save') : t('settings.saved') }}
        </Button>
        <Button
          v-if="dirtyModels"
          variant="ghost"
          size="sm"
          @click="resetActiveModelsDraft"
        >{{ t('settings.resetDraft') }}</Button>
        <Button
          v-if="hardware"
          variant="ghost"
          size="sm"
          class="ml-auto"
          @click="applyRecommended"
        >{{ t('settings.applyRecommended') }}</Button>
      </div>
    </section>

    <section class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Boxes class="h-3.5 w-3.5" />
          {{ t('settings.models.whisper') }}
        </h2>
        <div class="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-foreground"
                :aria-label="t('settings.models.refresh')"
                :disabled="modelsLoading"
                @click="loadModels"
              >
                <RefreshCw :class="modelsLoading ? 'animate-spin' : ''" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('settings.models.refresh') }}</TooltipContent>
          </Tooltip>
          <NuxtLink
            to="/setup-wizard?step=1"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Plus class="h-3.5 w-3.5" />
            {{ t('settings.models.downloadMore') }}
          </NuxtLink>
        </div>
      </div>
      <ul
        v-if="modelsData && modelsData.whisper.installed.length > 0"
        class="-mx-2 space-y-1 px-2"
      >
        <li
          v-for="m in modelsData.whisper.installed"
          :key="m.name"
          class="group flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
        >
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <span class="font-mono text-sm font-medium text-foreground">{{ m.name }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ fmtBytes(m.sizeBytes) }}</span>
            <!-- `auto` dispatches per audio (CJK→SenseVoice, en→Whisper), so
                 the configured tier counts as in use unless SenseVoice is
                 the pinned engine. -->
            <Badge
              v-if="m.name === modelsData.whisper.active && modelsData.transcribeEngine !== 'sensevoice'"
              variant="active"
              size="sm"
              class="uppercase tracking-wider"
            >
              <CheckCircle2 class="h-3 w-3" />
              {{ t('settings.models.active') }}
            </Badge>
          </div>
          <div class="flex items-center gap-1">
            <Button
              v-if="m.name !== modelsData.whisper.active"
              variant="secondary"
              size="xs"
              @click="setActiveWhisper(m.name)"
            >{{ t('settings.models.switch') }}</Button>
            <Button
              v-if="m.name !== modelsData.whisper.active"
              variant="ghost"
              size="xs"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="pendingDelete = { kind: 'whisper', name: m.name, sizeBytes: m.sizeBytes }"
            >
              <Trash2 />
              {{ t('settings.models.delete') }}
            </Button>
          </div>
        </li>
      </ul>
      <p
        v-else-if="modelsData"
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.empty') }}</p>
      <p
        v-else
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.loading') }}</p>
    </section>

    <section class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Boxes class="h-3.5 w-3.5" />
          {{ t('settings.models.sensevoice') }}
        </h2>
      </div>

      <div v-if="svInstall && svInstall.state === 'running'" class="space-y-2 px-2 py-2">
        <div class="flex items-center justify-between text-sm">
          <span class="font-mono">{{ t('settings.models.sensevoiceDownloading') }}</span>
          <span class="font-mono text-xs text-muted-foreground">
            {{
              svInstall.progress?.bytesTotal
                ? `${fmtBytes(svInstall.progress.bytesDownloaded)} / ${fmtBytes(svInstall.progress.bytesTotal)}`
                : fmtBytes(svInstall.progress?.bytesDownloaded ?? 0)
            }}
          </span>
        </div>
        <Button variant="ghost" size="xs" @click="cancelSenseVoiceInstall">
          {{ t('settings.models.cancel') }}
        </Button>
      </div>

      <ul v-else-if="senseVoiceReady" class="-mx-2 space-y-1 px-2">
        <li class="group flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50">
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <span class="font-mono text-sm font-medium text-foreground">SenseVoice-Small (int8)</span>
            <span class="font-mono text-xs text-muted-foreground">~247 MB</span>
            <!-- In use under both `auto` (CJK route) and the pinned engine —
                 only idle when Whisper is the pinned engine. -->
            <Badge
              v-if="modelsData?.transcribeEngine !== 'whisper'"
              variant="active"
              size="sm"
              class="uppercase tracking-wider"
            >
              <CheckCircle2 class="h-3 w-3" />
              {{ t('settings.models.active') }}
            </Badge>
          </div>
          <div class="flex items-center gap-1">
            <Button
              :disabled="modelsData?.transcribeEngine === 'sensevoice'"
              variant="ghost"
              size="xs"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              :title="modelsData?.transcribeEngine === 'sensevoice' ? t('settings.models.sensevoiceIsActive') : undefined"
              @click="deleteSenseVoice"
            >
              <Trash2 />
              {{ t('settings.models.delete') }}
            </Button>
          </div>
        </li>
      </ul>

      <div v-else class="flex flex-col items-center gap-3 px-2 py-4">
        <p class="text-center text-sm text-muted-foreground">
          {{ t('settings.models.sensevoiceEmpty') }}
        </p>
        <Button size="sm" @click="startSenseVoiceInstall">
          {{ t('settings.models.sensevoiceDownload') }}
        </Button>
      </div>
    </section>

    <section class="card">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Boxes class="h-3.5 w-3.5" />
          {{ t('settings.models.llm') }}
        </h2>

        <div
          v-if="llmInstall && llmInstall.state === 'running'"
          class="flex items-center gap-2 font-mono text-xs text-muted-foreground"
        >
          <RefreshCw class="h-3.5 w-3.5 animate-spin" />
          {{
            llmInstall.progress?.bytesTotal
              ? `${fmtBytes(llmInstall.progress.bytesDownloaded)} / ${fmtBytes(llmInstall.progress.bytesTotal)}`
              : fmtBytes(llmInstall.progress?.bytesDownloaded ?? 0)
          }}
        </div>
        <div class="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-foreground"
                :aria-label="t('settings.models.refresh')"
                :disabled="modelsLoading"
                @click="loadModels"
              >
                <RefreshCw :class="modelsLoading ? 'animate-spin' : ''" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('settings.models.refresh') }}</TooltipContent>
          </Tooltip>
          <NuxtLink
            to="/setup-wizard?step=2"
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Plus class="h-3.5 w-3.5" />
            {{ t('settings.models.downloadMore') }}
          </NuxtLink>
        </div>
      </div>

      <ul
        v-if="modelsData && modelsData.llm.installed.length > 0"
        class="-mx-2 space-y-1 px-2"
      >
        <li
          v-for="m in modelsData.llm.installed"
          :key="m.name"
          class="group flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
        >
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <span class="truncate font-mono text-sm font-medium text-foreground" :title="m.filename">{{ llmDisplayName(m.name) }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ fmtBytes(m.sizeBytes) }}</span>
            <Badge
              v-if="m.name === modelsData.llm.active"
              variant="active"
              size="sm"
              class="uppercase tracking-wider"
            >
              <CheckCircle2 class="h-3 w-3" />
              {{ t('settings.models.active') }}
            </Badge>
          </div>
          <div class="flex items-center gap-1">
            <Button
              v-if="m.name !== modelsData.llm.active"
              variant="secondary"
              size="xs"
              @click="setActiveLlm(m.name)"
            >{{ t('settings.models.switch') }}</Button>
            <Button
              v-if="m.name !== modelsData.llm.active"
              variant="ghost"
              size="xs"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="pendingDelete = { kind: 'llm', name: m.name, sizeBytes: m.sizeBytes }"
            >
              <Trash2 />
              {{ t('settings.models.delete') }}
            </Button>
          </div>
        </li>
      </ul>
      <p
        v-else-if="modelsData"
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.emptyLlm') }}</p>
      <p
        v-else
        class="py-4 text-center text-sm text-muted-foreground"
      >{{ t('settings.models.loading') }}</p>

      <div
        v-if="legacyLlmFiles.length > 0"
        class="mt-4 flex items-center justify-between gap-3 rounded-md border border-border/50 bg-accent/30 px-3 py-2.5"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">{{ t('settings.models.legacyLlmTitle') }}</p>
          <p class="text-xs text-muted-foreground">
            {{ legacyLlmFiles.length }} × Qwen2.5 ·
            {{ fmtBytes(legacyLlmTotal) }} ·
            {{ t('settings.models.legacyLlmHint') }}
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          class="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          @click="deleteLegacyLlm"
        >
          <Trash2 />
          {{ t('settings.models.delete') }}
        </Button>
      </div>
    </section>

    <Dialog
      :open="pendingDelete !== null"
      @update:open="(v: boolean) => { if (!v) pendingDelete = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('settings.models.deleteTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{
              t('settings.models.deleteDesc', {
                name: pendingDelete?.name ?? '',
                size: pendingDelete ? fmtBytes(pendingDelete.sizeBytes) : '',
              })
            }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingDelete = null">
            {{ t('settings.models.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmDelete">
            <Trash2 class="h-4 w-4" />
            {{ t('settings.models.confirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
