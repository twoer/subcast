<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- app/pages/index.vue -->
<script setup lang="ts">
import { AlertCircle, Check, Upload, ListVideo, X, Film, FileText, History, ArrowRight, FileStack, RotateCcw } from 'lucide-vue-next';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { getFileStatus } from '~/utils/fileStatus';
import { isTaskErrorCode } from '#shared/errorCodes';
import { useQueueList, type QueueItem } from '~/composables/useQueueList';
import { useBatchList } from '~/composables/useBatchList';
import { useHomeUpload } from '~/composables/useHomeUpload';
import { useBatchStaging } from '~/composables/useBatchStaging';
import { useDesktopOpenFileUpload } from '~/composables/useDesktopOpenFileUpload';
import { useClipboardFeedback } from '~/composables/useClipboardFeedback';
import { useUploadStatus } from '~/composables/useUploadStatus';
import { fmtBytes } from '~/utils/format';
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
  langs: string[];
  createdAt: number;
  lastOpenedAt: number;
}

const cachedVideos = ref<CacheEntry[]>([]);

const { items: queueItems, loaded: queueLoaded, refresh: refreshQueue } = useQueueList();
const { items: batchItems, refresh: refreshBatches } = useBatchList();
const healthData = ref<HealthResp | null>(null);
const pendingCancelTask = ref<QueueItem | null>(null);
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
  if (!s.hasWhisperModel) gaps.push(t('desktop.home.gapWhisper'));
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

async function cancelBatch(batch: BatchJobSummary): Promise<void> {
  await $fetch(`/api/batches/${batch.id}/cancel`, { method: 'POST' });
  await refreshBatches();
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

// Render a structured error code via i18n; fall back to the raw message
// when the code is unknown (worker emitted a code we don't have a key
// for, or the row predates the error_code column).
function friendlyTaskError(item: QueueItem): string {
  if (isTaskErrorCode(item.errorCode)) {
    return t(`player.errors.${item.errorCode}`);
  }
  return item.errorMsg ?? '';
}

// Kind label: noun form regardless of status. The status badge already
// conveys queued/running/done/failed via colour, so the line just names
// the task ("what was/is being done") plus its parameters.
function fmtKindLabel(item: QueueItem): string {
  if (item.kind === 'insight') {
    return `${insightLabel(item.uiLanguage)} · ${item.model}`;
  }
  if (item.kind === 'transcribe') {
    return `${t('index.kindTranscribe')} · whisper:${item.model}`;
  }
  if (item.kind === 'diarize') {
    // Show K parameter when the task has progressed past Stage 2;
    // pending/running tasks don't have it yet.
    const suffix = item.topK ? ` · K=${item.topK}` : '';
    return `${t('index.kindDiarize')}${suffix} · ${item.model}`;
  }
  return `${t('index.kindTranslate')} ${item.targetLang} · ${item.model}`;
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
          {{ isUploading ? t('index.uploading') : t('index.choose') }}
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
                <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <FileStatusBadges :status="getFileStatus(item, queueItems)" />
                  <span v-if="item.langs.length === 0 && getFileStatus(item, queueItems).transcribe === 'none'">
                    {{ t('index.library.noSubs') }}
                  </span>
                  <span class="font-mono">{{ fmtBytes(item.videoBytes + item.cacheBytes) }}</span>
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
                  <Progress
                    v-if="batch.status === 'running' || batch.status === 'queued'"
                    :model-value="batchProgressPct(batch)"
                    class="mt-2 h-1.5"
                  />
                  <p v-if="batch.errorMsg" class="mt-1 truncate text-xs text-destructive">
                    {{ batch.errorMsg }}
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
                        <RotateCcw />
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
                        @click="cancelBatch(batch)"
                      >
                        <X />
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
                <Badge variant="outline" size="sm" :class="statusBadgeClass(item.status)">
                  {{ t(`index.status.${item.status}`) }}
                </Badge>
              </div>
              <div class="mt-1 text-xs text-muted-foreground">{{ fmtKindLabel(item) }}</div>
              <Progress
                v-if="item.status === 'running' || item.status === 'queued'"
                :model-value="item.progressPct"
                class="mt-2 h-1.5"
              />
              <p
                v-if="item.errorMsg || item.errorCode"
                class="mt-1 truncate text-xs text-destructive"
                :title="item.errorMsg ?? ''"
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
                    <X />
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
            <X class="h-4 w-4" />
            {{ t('index.cancelTaskConfirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </AppShell>
</template>
