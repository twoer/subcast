<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- app/pages/index.vue -->
<script setup lang="ts">
import { AlertCircle, Check, Upload, ListVideo, X, Film, FileText, History, ArrowRight, FileStack, RotateCcw, Link2 } from 'lucide-vue-next';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { getFileStatus } from '~/utils/fileStatus';
import { displayQueueModel } from '~/utils/modelDisplay';
import { isTaskErrorCode } from '#shared/errorCodes';
import { useQueueList, type QueueItem } from '~/composables/useQueueList';
import { useBatchList } from '~/composables/useBatchList';
import { useHomeUpload } from '~/composables/useHomeUpload';
import { useBatchStaging } from '~/composables/useBatchStaging';
import { useDesktopOpenFileUpload } from '~/composables/useDesktopOpenFileUpload';
import { useUrlImport } from '~/composables/useUrlImport';
import { useClipboardFeedback } from '~/composables/useClipboardFeedback';
import { useUploadStatus } from '~/composables/useUploadStatus';
import type { BatchJobSummary } from '#shared/batch';

interface HealthFix {
  id: string;
  description: string;
  command: string;
}
interface HealthResp {
  health: { ready: boolean; missing: string[] };
  fixes: HealthFix[];
  hardware: { tier: string; totalMemoryGB: number; gpu: string; lanIp?: string };
  lanUrl: string | null;
}

const { t } = useI18n();

// Shared upload status across home/batch/desktop-open-file upload flows.
// One instance so the upload button, error banner, and info line all reflect
// a single in-flight operation, and so each entry point can no-op when
// another upload is already running instead of clobbering its state.
const uploadStatus = useUploadStatus();
const { isUploading, error, info } = uploadStatus;

interface CacheEntry {
  sha256: string;
  originalName: string;
  displayName: string | null;
  ext: string;
  videoBytes: number;
  cacheBytes: number;
  /** Media duration in seconds; null while a background probe is pending or unavailable. */
  durationS: number | null;
  langs: string[];
  createdAt: number;
  lastOpenedAt: number;
}

const cachedVideos = ref<CacheEntry[]>([]);

const { items: queueItems, loaded: queueLoaded, refresh: refreshQueue } = useQueueList();
const { items: batchItems, refresh: refreshBatches } = useBatchList();
const healthData = ref<HealthResp | null>(null);
const pendingCancelTask = ref<QueueItem | null>(null);
const pendingCancelBatch = ref<BatchJobSummary | null>(null);
let healthHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Desktop-only: in-wizard pieces that are still missing. `null` in web
 * mode (the endpoint 404s and we fall back to undefined). Surfaces a
 * "Return to Setup" banner above the upload zone so users who skipped a
 * step have a single click back into the wizard.
 *
 * The wizard itself splits into Whisper (setup-status) + LLM (llm/status)
 * since the post-llama.cpp migration, so we probe both in parallel.
 */
interface DesktopSetupStatus {
  hasWhisperModel: boolean;
  /** SenseVoice bundled model present — step 1 satisfied without Whisper. */
  sensevoiceReady?: boolean;
}
interface LlmStatusResp {
  installed: Array<{ name: string }>;
}
const desktopSetup = ref<DesktopSetupStatus | null>(null);
const llmStatus = ref<LlmStatusResp | null>(null);

async function refreshDesktopSetup(): Promise<void> {
  try {
    const [status, llm] = await Promise.all([
      $fetch<DesktopSetupStatus>('/api/desktop/setup-status'),
      $fetch<LlmStatusResp>('/api/desktop/llm/status'),
    ]);
    desktopSetup.value = status;
    llmStatus.value = llm;
  } catch {
    desktopSetup.value = null;
    llmStatus.value = null;
  }
}

const desktopSetupGaps = computed<string[]>(() => {
  const s = desktopSetup.value;
  if (!s) return [];
  const gaps: string[] = [];
  // Step 1 is satisfied by EITHER engine (mirrors setup-check + the
  // wizard's own resume logic) — SenseVoice-only installs are complete.
  if (!s.hasWhisperModel && s.sensevoiceReady !== true) gaps.push(t('desktop.home.gapWhisper'));
  if ((llmStatus.value?.installed.length ?? 0) === 0) gaps.push(t('desktop.home.gapLlm'));
  return gaps;
});

async function refreshHealth() {
  try {
    const res = await $fetch<HealthResp>('/api/health');
    healthData.value = res;
  } catch {
    /* network blip */
  }
}

const { copiedKey: copiedId, copy: copyToClipboard } = useClipboardFeedback<string>();

const { count: libraryCount } = useLibraryCount();

async function refreshLibrary() {
  try {
    const res = await $fetch<{ items: CacheEntry[]; totals: { count: number } }>('/api/cache/list');
    cachedVideos.value = res.items.slice(0, 15);
    libraryCount.value = res.totals.count;
  } catch {
    /* non-critical */
  }
}

const {
  pendingBatchFiles,
  pendingBatchHashes,
  showBatchDialog,
  batchProgress,
  batchReusedUploads,
  prepareBatchFiles,
  startBatchUpload,
  onBatchDialogOpenChange,
} = useBatchStaging({
  t,
  status: uploadStatus,
  refreshQueue,
  refreshBatches,
  refreshLibrary,
});

const {
  fileInput,
  pendingPair,
  onPickFile,
  onDrop,
  dialogChoose,
} = useHomeUpload({
  t,
  status: uploadStatus,
  prepareBatchFiles,
});

const {
  phase: urlImportPhase,
  percent: urlImportPercent,
  urlInput,
  importUrl,
  cancel: cancelUrlImport,
} = useUrlImport({
  t,
  status: uploadStatus,
});

function onSubmitUrl(): void {
  void importUrl(urlInput.value);
  urlInput.value = '';
}

useDesktopOpenFileUpload({
  t,
  status: uploadStatus,
});

function fmtTimeAgo(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return t('index.library.justNow');
  if (diffSec < 3600) return t('index.library.minutesAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t('index.library.hoursAgo', { n: Math.floor(diffSec / 3600) });
  return t('index.library.daysAgo', { n: Math.floor(diffSec / 86400) });
}

function requestCancelTask(item: QueueItem) {
  pendingCancelTask.value = item;
}

function requestCancelBatch(batch: BatchJobSummary) {
  pendingCancelBatch.value = batch;
}

async function confirmCancelTask() {
  const item = pendingCancelTask.value;
  if (!item) return;
  pendingCancelTask.value = null;
  try {
    await $fetch(`/api/queue/${item.kind}/${item.id}`, { method: 'DELETE' });
    void refreshQueue();
  } catch {
    /* surfaced via next refresh */
  }
}

const activeCount = computed(
  () =>
    queueItems.value.filter((i) => i.status === 'queued' || i.status === 'running').length,
);

const visibleBatchItems = computed(() =>
  batchItems.value.filter((b) =>
    b.status === 'queued'
    || b.status === 'running'
    || b.failedItems > 0
    || Date.now() - b.createdAt < 24 * 60 * 60 * 1000,
  ),
);

function batchProgressPct(batch: BatchJobSummary): number {
  if (batch.totalItems <= 0) return 0;
  return Math.round(((batch.doneItems + batch.failedItems) / batch.totalItems) * 100);
}

function showBatchTranscribedProgress(batch: BatchJobSummary): boolean {
  return batch.options.executionStrategy === 'fast_first'
    && batch.transcribedItems > batch.doneItems
    && batch.transcribedItems > 0;
}

async function cancelBatch(batch: BatchJobSummary): Promise<void> {
  await $fetch(`/api/batches/${batch.id}/cancel`, { method: 'POST' });
  await refreshBatches();
}

async function confirmCancelBatch(): Promise<void> {
  const batch = pendingCancelBatch.value;
  if (!batch) return;
  pendingCancelBatch.value = null;
  try {
    await cancelBatch(batch);
  } catch {
    /* surfaced via next refresh */
  }
}

async function retryBatch(batch: BatchJobSummary): Promise<void> {
  await $fetch(`/api/batches/${batch.id}/retry`, { method: 'POST' });
  await Promise.all([refreshBatches(), refreshQueue()]);
}

// useQueueList() handles the queue poll lifecycle internally.
onMounted(() => {
  void refreshHealth();
  void refreshLibrary();
  void refreshDesktopSetup();
  healthHandle = setInterval(refreshHealth, 10_000);
});
onBeforeUnmount(() => {
  if (healthHandle) clearInterval(healthHandle);
});

// Returns "<kind> (<insight content language>)" — both halves localized.
function insightLabel(lang: string | undefined): string {
  return lang === 'zh-CN' ? t('index.kindInsightZh') : t('index.kindInsightEn');
}

function isCanceledByUserMessage(message: string | null | undefined): boolean {
  return /^cancel(?:l)?ed by user[.!]?$/i.test(message?.trim() ?? '');
}

// Render a structured error code via i18n; fall back to the raw message
// when the code is unknown (worker emitted a code we don't have a key
// for, or the row predates the error_code column).
function friendlyTaskError(item: QueueItem): string {
  if (isCanceledTask(item)) return '';
  if (isTaskErrorCode(item.errorCode)) {
    return t(`player.errors.${item.errorCode}`);
  }
  return item.errorMsg ?? '';
}

// Older task rows only recorded the English message, while newer rows use
// the structured CANCELED code. Normalize both here so a cancellation is
// presented as a status instead of a red failure plus a raw backend message.
function isCanceledTask(item: QueueItem): boolean {
  return item.status === 'canceled'
    || item.errorCode === 'CANCELED'
    || isCanceledByUserMessage(item.errorMsg);
}

function displayTaskStatus(item: QueueItem): QueueItem['status'] {
  return isCanceledTask(item) ? 'canceled' : item.status;
}

function friendlyBatchError(batch: BatchJobSummary): string {
  if (batch.status === 'canceled' || isCanceledByUserMessage(batch.errorMsg)) return '';
  return batch.errorMsg ?? '';
}

// Kind label: noun form regardless of status. The status badge already
// conveys queued/running/done/failed via colour, so the line just names
// the task ("what was/is being done") plus its parameters.
//
function displayDiarizeModelPart(model: string, index: 0 | 1): string {
  const parts = model.split(' · ');
  const part = parts[index] ?? model;
  switch (part.toLowerCase()) {
    case 'sherpa-onnx': return 'Sherpa ONNX';
    case 'campplus': return 'CAMPPlus';
    default: return part;
  }
}

function fmtKindLabel(item: QueueItem): string {
  if (item.kind === 'insight') {
    return `${insightLabel(item.uiLanguage)} · ${displayQueueModel(item.model)}`;
  }
  if (item.kind === 'transcribe') {
    return `${t('index.kindTranscribe')} · ${displayQueueModel(item.model)}`;
  }
  if (item.kind === 'diarize') {
    return t('index.kindDiarize');
  }
  if (item.kind === 'polish') {
    return `${t('index.kindPolish')} · ${displayQueueModel(item.model)}`;
  }
  return `${t('index.kindTranslate')} ${item.targetLang} · ${displayQueueModel(item.model)}`;
}

function statusBadgeClass(s: QueueItem['status']) {
  switch (s) {
    case 'running':
      return 'bg-primary/10 text-primary border-transparent hover:bg-primary/15';
    case 'completed':
    case 'done':
      return 'border-success/40 bg-success/10 text-success';
    case 'failed':
    case 'error':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'canceled':
      return 'border-border bg-muted text-muted-foreground';
    case 'queued':
    default:
      return 'border-border bg-secondary text-secondary-foreground';
  }
}
</script>

<template>
  <AppShell>
    <template #header>
      <AppHeader :lan-url="healthData?.lanUrl" />
    </template>

    <div class="mx-auto w-full max-w-screen-2xl px-4">

      <NuxtLink
        v-if="desktopSetupGaps.length > 0"
        to="/setup-wizard"
        class="surface-1 mb-6 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3 text-sm transition-colors hover:bg-warning/[0.10]"
      >
        <AlertCircle class="h-4 w-4 shrink-0 text-warning" />
        <span class="flex-1">
          <span class="font-medium text-foreground">{{ t('desktop.home.setupIncomplete') }}</span>
          <span class="text-muted-foreground"> {{ desktopSetupGaps.join(' · ') }}</span>
        </span>
        <span class="inline-flex items-center gap-1 text-xs text-warning">
          {{ t('desktop.home.openSetupWizard') }}
          <ArrowRight class="h-3.5 w-3.5" />
        </span>
      </NuxtLink>

      <div
        v-if="healthData && !healthData.health.ready && !desktopSetup"
        class="surface-1 mb-6 overflow-hidden rounded-xl border border-warning/20"
      >
        <div class="flex items-center gap-2.5 border-b border-warning/10 bg-warning/[0.04] px-4 py-3 dark:bg-warning/[0.06]">
          <AlertCircle class="h-4 w-4 shrink-0 text-warning" />
          <span class="flex-1 text-sm font-medium text-foreground">{{ t('health.missing') }}</span>
          <Button
            variant="ghost"
            size="xs"
            class="text-muted-foreground hover:text-foreground"
            @click="refreshHealth"
          >{{ t('health.recheck') }}</Button>
        </div>
        <div class="divide-y divide-border/50">
          <div
            v-for="fix in healthData.fixes"
            :key="fix.id"
            class="px-4 py-3"
          >
            <div class="text-sm font-medium text-foreground">{{ fix.description }}</div>
            <div class="mt-1.5 flex items-center gap-2">
              <code class="min-w-0 flex-1 select-all break-all rounded-md bg-muted/80 px-3 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground">
                {{ fix.command }}
              </code>
              <Button
                :variant="copiedId === fix.id ? 'default' : 'outline'"
                size="sm"
                class="h-8 shrink-0 gap-1.5 text-xs"
                @click="copyToClipboard(fix.id, fix.command)"
              >
                <Check v-if="copiedId === fix.id" class="h-3 w-3" />
                {{ copiedId === fix.id ? t('health.copied') : t('health.copy') }}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div
        class="surface-1 group rounded-xl border border-dashed border-input bg-card/40 px-8 py-10 text-center transition-all duration-200 hover:border-primary/60 hover:bg-card/70 hover:shadow-md"
        @dragover.prevent
        @drop="onDrop"
      >
        <div class="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary ring-[6px] ring-primary/5 transition-transform duration-200 group-hover:scale-105">
          <Upload class="h-5 w-5" />
        </div>
        <p class="mb-1.5 text-sm font-medium text-foreground">
          {{ t('index.drop') }}
        </p>
        <p class="mb-5 font-mono text-xs text-muted-foreground">mp4 · mkv · mov · webm · mp3 · wav · m4a (≤ 2 GB)</p>
        <Button
          size="lg"
          :disabled="isUploading"
          @click="fileInput?.click()"
        >
          {{ (isUploading && urlImportPhase === 'idle') ? t('index.uploading') : t('index.choose') }}
        </Button>
        <p v-if="batchProgress" class="mt-3 text-xs text-muted-foreground">
          {{ t('batch.uploadProgress', { done: batchProgress.done, total: batchProgress.total }) }}
        </p>
        <input
          ref="fileInput"
          type="file"
          accept="video/*,audio/*,.srt,.vtt,.ass"
          multiple
          class="hidden"
          @change="onPickFile"
        >

        <!-- URL import: integrated into the drop zone as a compact secondary
             entry. A divider + "or" separates local-file (primary) from
             URL (secondary), keeping the two import modes visually unified
             rather than two disconnected boxes. -->
        <div class="mx-auto mt-6 flex max-w-md items-center gap-3 text-xs text-muted-foreground">
          <span class="h-px flex-1 bg-border" />
          {{ t('index.urlImport.or') }}
          <span class="h-px flex-1 bg-border" />
        </div>
        <form
          class="mx-auto mt-3 flex max-w-md items-center gap-2"
          @submit.prevent="onSubmitUrl"
        >
          <div class="flex flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
            <Link2 class="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              v-model="urlInput"
              type="url"
              :placeholder="t('index.urlImport.placeholder')"
              :disabled="isUploading"
              class="h-9 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            class="h-9 shrink-0"
            :disabled="isUploading || !urlInput.trim()"
          >
            {{ t('index.urlImport.button') }}
          </Button>
          <Button
            v-if="urlImportPhase === 'downloading' || urlImportPhase === 'fetching_info'"
            type="button"
            size="sm"
            variant="ghost"
            class="h-9 shrink-0 px-2"
            @click="cancelUrlImport"
          >
            <X class="h-4 w-4" />
          </Button>
        </form>
        <!-- Inline progress bar: only takes one line during download,
             replaces the separate progress block. -->
        <div
          v-if="urlImportPhase === 'downloading' || urlImportPhase === 'fetching_info' || urlImportPhase === 'finalizing'"
          class="mx-auto mt-2 flex max-w-md items-center gap-2 text-xs text-muted-foreground"
        >
          <Progress
            :model-value="Math.round(urlImportPercent * 100)"
            class="url-import-progress h-1.5 flex-1"
          />
          <span class="shrink-0 font-mono tabular-nums">
            {{ Math.round(urlImportPercent * 100) }}%
          </span>
        </div>
      </div>

      <Alert v-if="error" variant="destructive" class="mt-4">
        <AlertCircle class="h-4 w-4" />
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>
      <Alert v-else-if="info" class="mt-4">
        <Check class="h-4 w-4" />
        <AlertDescription>{{ info }}</AlertDescription>
      </Alert>

      <section v-if="cachedVideos.length > 0" class="mt-8">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <History class="h-3.5 w-3.5" />
            {{ t('index.library.title') }}
          </h2>
          <NuxtLink
            to="/library"
            class="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >{{ t('index.library.more') }}</NuxtLink>
        </div>
        <div class="card-list">
          <ul class="space-y-1">
            <li
              v-for="item in cachedVideos"
              :key="item.sha256"
              class="group/row flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent/50"
            >
              <RowIconBadge kind="media" :ext="item.ext" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1">
                  <NuxtLink
                    :to="`/player/${item.sha256}`"
                    class="truncate text-sm font-medium text-foreground hover:underline"
                    :title="item.originalName"
                  >{{ item.displayName || item.originalName }}</NuxtLink>
                </div>
                <div class="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <MediaMetaPills
                    :duration-s="item.durationS"
                    :bytes="item.videoBytes + item.cacheBytes"
                  />
                  <FileStatusBadges :status="getFileStatus(item, queueItems)" />
                  <span
                    v-if="item.langs.length === 0 && getFileStatus(item, queueItems).transcribe === 'none'"
                    class="text-2xs"
                  >
                    {{ t('index.library.noSubs') }}
                  </span>
                </div>
              </div>
              <span class="shrink-0 text-2xs text-muted-foreground">
                {{ fmtTimeAgo(item.lastOpenedAt) }}
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section class="mt-10">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <ListVideo class="h-3.5 w-3.5" />
            {{ t('index.queue') }}
          </h2>
          <span v-if="queueItems.length > 0" class="text-xs text-muted-foreground">
            {{ t('index.queueMeta', { active: activeCount, total: queueItems.length }) }}
          </span>
        </div>
        <div class="card-list">
          <p
            v-if="!queueLoaded"
            class="px-3 py-4 text-sm text-muted-foreground"
          >
            {{ t('index.queueLoading') }}
          </p>
          <div v-else-if="visibleBatchItems.length > 0 || queueItems.length > 0" class="space-y-2">
            <div
              v-for="batch in visibleBatchItems"
              :key="batch.id"
              class="rounded-md bg-muted/25 px-3 py-3 transition-colors hover:bg-accent/40"
            >
              <div class="flex items-start gap-3">
                <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <FileStack class="h-4 w-4" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate text-sm font-medium text-foreground">{{ batch.name }}</span>
                    <Badge variant="outline" size="sm" :class="statusBadgeClass(batch.status as QueueItem['status'])">
                      {{ t(`index.status.${batch.status}`) }}
                    </Badge>
                  </div>
                  <div class="mt-1 text-xs text-muted-foreground">
                    {{ t('batch.summary', { done: batch.doneItems, failed: batch.failedItems, total: batch.totalItems }) }}
                  </div>
                  <div
                    v-if="showBatchTranscribedProgress(batch)"
                    class="mt-1 flex items-center gap-1.5 text-xs text-primary"
                  >
                    <FileText class="size-3.5 shrink-0" />
                    <span class="min-w-0 truncate">
                      {{ t('batch.originalReady', { done: batch.transcribedItems, total: batch.totalItems }) }}
                    </span>
                  </div>
                  <Progress
                    v-if="batch.status === 'running' || batch.status === 'queued'"
                    :model-value="batchProgressPct(batch)"
                    class="mt-2 h-1.5"
                  />
                  <p
                    v-if="friendlyBatchError(batch)"
                    class="mt-1 truncate text-xs text-destructive"
                    :title="friendlyBatchError(batch)"
                  >
                    {{ friendlyBatchError(batch) }}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Tooltip v-if="batch.failedItems > 0">
                    <TooltipTrigger as-child>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        class="text-muted-foreground hover:bg-accent hover:text-foreground"
                        :aria-label="t('batch.retryFailed')"
                        @click="retryBatch(batch)"
                      >
                        <RotateCcw class="h-4 w-4 shrink-0" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ t('batch.retryFailed') }}</TooltipContent>
                  </Tooltip>
                  <Tooltip v-if="batch.status === 'queued' || batch.status === 'running'">
                    <TooltipTrigger as-child>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        :aria-label="t('index.cancel')"
                        @click="requestCancelBatch(batch)"
                      >
                        <X class="h-4 w-4 shrink-0" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ t('index.cancel') }}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
            <ul v-if="queueItems.length > 0" class="space-y-1">
            <li
              v-for="item in queueItems"
              :key="`${item.kind}:${item.id}`"
              class="flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent/50"
            >
              <RowIconBadge :kind="item.kind" />
              <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.videoSha}`"
                  class="max-w-xs truncate font-medium text-foreground hover:underline"
                  :title="item.videoName"
                >{{ item.videoName }}</NuxtLink>
                <Badge variant="outline" size="sm" :class="statusBadgeClass(displayTaskStatus(item))">
                  {{ t(`index.status.${displayTaskStatus(item)}`) }}
                </Badge>
              </div>
              <div
                v-if="item.kind === 'diarize'"
                class="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span class="shrink-0">{{ fmtKindLabel(item) }}</span>
                <Badge variant="secondary" size="sm" class="gap-1 font-normal text-muted-foreground">
                  <span>{{ t('index.engine') }}</span>
                  <span>{{ displayDiarizeModelPart(item.model, 0) }}</span>
                </Badge>
                <Badge variant="secondary" size="sm" class="gap-1 font-normal text-muted-foreground">
                  <span>{{ t('index.model') }}</span>
                  <span>{{ displayDiarizeModelPart(item.model, 1) }}</span>
                </Badge>
                <Badge
                  v-if="item.finalSpeakerCount != null || item.topK != null"
                  variant="secondary"
                  size="sm"
                  class="font-normal text-muted-foreground"
                >
                  {{ item.finalSpeakerCount != null
                    ? t('index.detectedSpeakerCount', { count: item.finalSpeakerCount })
                    : t('index.targetSpeakerCount', { count: item.topK }) }}
                </Badge>
              </div>
              <div v-else class="mt-1 text-xs text-muted-foreground">{{ fmtKindLabel(item) }}</div>
              <Progress
                v-if="item.status === 'running' || item.status === 'queued'"
                :model-value="item.progressPct"
                class="mt-2 h-1.5"
              />
              <p
                v-if="friendlyTaskError(item)"
                class="mt-1 truncate text-xs text-destructive"
                :title="friendlyTaskError(item)"
              >{{ friendlyTaskError(item) }}</p>
            </div>
            <div class="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
              <Tooltip v-if="item.kind === 'transcribe' && item.totalChunks">
                <TooltipTrigger as-child>
                  <span class="cursor-help">{{ item.doneChunks }}/{{ item.totalChunks }}</span>
                </TooltipTrigger>
                <TooltipContent>{{ t('index.chunkTooltip', { total: item.totalChunks }) }}</TooltipContent>
              </Tooltip>
              <template v-else-if="item.status === 'running' || item.status === 'queued'">
                {{ item.progressPct }}%
              </template>
            </div>
              <Tooltip v-if="item.status === 'queued' || item.status === 'running'">
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    :aria-label="t('index.cancel')"
                    @click="requestCancelTask(item)"
                  >
                    <X class="h-4 w-4 shrink-0" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t('index.cancel') }}</TooltipContent>
              </Tooltip>
            </li>
            </ul>
          </div>
          <p v-else class="px-3 py-4 text-sm text-muted-foreground">
            {{ t('index.queueEmpty') }}
          </p>
          <!-- v-else above is queueLoaded && items.length === 0 -->

        </div>
      </section>
    </div>

    <Dialog
      :open="pendingPair !== null"
      @update:open="(v: boolean) => { if (!v) dialogChoose(false) }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('companion.title') }}</DialogTitle>
          <DialogDescription>{{ t('companion.body') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-1.5 rounded-md border border-border/60 bg-muted/60 p-3 font-mono text-xs">
          <div class="flex items-center gap-2">
            <Film class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ pendingPair?.video.name }}</span>
          </div>
          <div class="flex items-center gap-2">
            <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ pendingPair?.subtitle.name }}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" @click="dialogChoose(false)">
            {{ t('companion.ignore') }}
          </Button>
          <Button @click="dialogChoose(true)">
            {{ t('companion.useExisting') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <BatchCreateDialog
      :open="showBatchDialog"
      :count="pendingBatchFiles.length"
      :video-shas="pendingBatchHashes"
      :reused-count="batchReusedUploads"
      @update:open="onBatchDialogOpenChange"
      @start="startBatchUpload"
    />

    <Dialog
      :open="pendingCancelTask !== null"
      @update:open="(v: boolean) => { if (!v) pendingCancelTask = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('index.cancelTaskTitle') }}</DialogTitle>
          <DialogDescription>
            {{ t('index.cancelTaskDesc', { name: pendingCancelTask?.videoName ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingCancelTask = null">
            {{ t('common.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmCancelTask">
            <span class="inline-flex items-center gap-1.5">
              <X class="h-4 w-4 shrink-0" />
              <span>{{ t('index.cancelTaskConfirm') }}</span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="pendingCancelBatch !== null"
      @update:open="(v: boolean) => { if (!v) pendingCancelBatch = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('index.cancelBatchTitle') }}</DialogTitle>
          <DialogDescription>
            {{ t('index.cancelBatchDesc', { name: pendingCancelBatch?.name ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="pendingCancelBatch = null">
            {{ t('common.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmCancelBatch">
            <span class="inline-flex items-center gap-1.5">
              <X class="h-4 w-4 shrink-0" />
              <span>{{ t('index.cancelBatchConfirm') }}</span>
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </AppShell>
</template>

<style scoped>
/* Smooth the URL-import progress bar. yt-dlp emits progress in
   exponentially-spaced ticks (0% → 0.4% → 3% → 27% → 100% on a small
   file), so without a transition the indicator visibly jumps. A short
   ease-out smooths the visual without lagging behind real movement.
   Scoped to the URL import bar so the shared transcription/translation
   Progress components are unaffected. */
.url-import-progress :deep([role='progressbar'] > *) {
  transition: transform 0.4s ease-out;
}
</style>
