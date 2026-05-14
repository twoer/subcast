<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- app/pages/index.vue -->
<script setup lang="ts">
import { AlertCircle, Check, Upload, ListVideo, X, Film, FileText, History, ArrowRight } from 'lucide-vue-next';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { getFileStatus } from '~/utils/fileStatus';

interface QueueItem {
  kind: 'transcribe' | 'translate' | 'insight';
  id: string;
  videoSha: string;
  videoName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'done' | 'error';
  model: string;
  progressPct: number;
  totalChunks?: number | null;
  doneChunks?: number;
  targetLang?: string;
  uiLanguage?: 'zh-CN' | 'en';
  createdAt: number;
  errorMsg?: string | null;
  errorCode?: string | null;
}

// Known error codes the workers emit. Anything outside this set falls
// back to showing the raw error_msg (still useful for debugging).
const KNOWN_ERROR_CODES = new Set([
  'WHISPER_NOT_CONFIGURED',
  'MODEL_NOT_CONFIGURED',
  'ORIGINAL_NOT_READY',
  'BATCH_RETRY_EXHAUSTED',
  'PARSE_FAILED',
  'FATAL_UNKNOWN',
]);

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

const SUB_EXT_RE = /\.(srt|vtt|ass)$/i;
const VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|mp3|wav|m4a)$/i;

const isUploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const pendingPair = ref<{ video: File; subtitle: File } | null>(null);

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

const queueItems = ref<QueueItem[]>([]);
// Distinguishes "not yet loaded" from "loaded, no tasks" so the panel
// doesn't flash "no tasks" during the first poll after mount / remount.
const queueLoaded = ref(false);
const healthData = ref<HealthResp | null>(null);
let pollHandle: ReturnType<typeof setInterval> | null = null;
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

const copiedId = ref<string | null>(null);

async function copyToClipboard(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
  copiedId.value = id;
  setTimeout(() => { if (copiedId.value === id) copiedId.value = null; }, 2000);
}

async function refreshQueue() {
  try {
    const res = await $fetch<{ items: QueueItem[] }>('/api/queue/list');
    queueItems.value = res.items;
    queueLoaded.value = true;
  } catch {
    /* network blip; ignore — keep last snapshot + loaded flag */
  }
}

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

function fmtTimeAgo(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return t('index.library.justNow');
  if (diffSec < 3600) return t('index.library.minutesAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t('index.library.hoursAgo', { n: Math.floor(diffSec / 3600) });
  return t('index.library.daysAgo', { n: Math.floor(diffSec / 86400) });
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

async function uploadVideoOnly(file: File) {
  error.value = null;
  isUploading.value = true;
  try {
    const fd = new FormData();
    fd.append('video', file);
    const res = await $fetch<{ hash: string }>('/api/upload', {
      method: 'POST',
      body: fd,
    });
    await navigateTo(`/player/${res.hash}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'upload failed';
  } finally {
    isUploading.value = false;
  }
}

async function uploadVideoWithSubs(video: File, subtitle: File) {
  error.value = null;
  isUploading.value = true;
  try {
    const fd = new FormData();
    fd.append('video', video);
    fd.append('subtitle', subtitle);
    const res = await $fetch<{ hash: string; imported: boolean }>('/api/upload', {
      method: 'POST',
      body: fd,
    });
    await navigateTo(`/player/${res.hash}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'upload failed';
  } finally {
    isUploading.value = false;
  }
}

function baseName(f: File): string {
  return f.name.replace(/\.[^.]+$/, '');
}

function pickPair(files: File[]): { video: File; subtitle: File } | null {
  const videos = files.filter((f) => VIDEO_EXT_RE.test(f.name));
  const subs = files.filter((f) => SUB_EXT_RE.test(f.name));
  if (videos.length === 0) return null;
  const v = videos[0]!;
  const baseV = baseName(v).toLowerCase();
  const matched =
    subs.find((s) => {
      let baseS = baseName(s).toLowerCase();
      // Strip lang suffix like '.zh' / '.en' / '.zh-cn'
      baseS = baseS.replace(/\.[a-z]{2}(-[a-z]{2})?$/, '');
      return baseS === baseV;
    }) ?? subs[0];
  if (!matched) return null;
  return { video: v, subtitle: matched };
}

const { t } = useI18n();

async function handleFiles(files: File[]) {
  if (files.length === 0) return;
  const videos = files.filter((f) => VIDEO_EXT_RE.test(f.name));
  if (videos.length === 0) {
    error.value = t('index.noVideo');
    return;
  }
  const pair = pickPair(files);
  if (pair) {
    pendingPair.value = pair;
    return;
  }
  await uploadVideoOnly(videos[0]!);
}

function onPickFile(e: Event) {
  const list = (e.target as HTMLInputElement).files;
  if (!list) return;
  void handleFiles(Array.from(list));
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const list = e.dataTransfer?.files;
  if (!list) return;
  void handleFiles(Array.from(list));
}

function dialogChoose(useImport: boolean) {
  const p = pendingPair.value;
  if (!p) return;
  pendingPair.value = null;
  if (useImport) void uploadVideoWithSubs(p.video, p.subtitle);
  else void uploadVideoOnly(p.video);
}

async function cancelTask(item: QueueItem) {
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

/**
 * Desktop-only: handle paths the OS shell hands us. The Electron main
 * process delivers them as a `subcast:open-file` CustomEvent on `window`
 * (see `app/plugins/desktop-open-file.client.ts`). We import the file
 * via the desktop-mode-only `/api/desktop/upload-from-path` and navigate
 * to the player — the same UX as a successful drag-drop in the browser.
 */
async function handleOsOpenFile(path: string): Promise<void> {
  error.value = null;
  isUploading.value = true;
  try {
    const res = await $fetch<{ hash: string }>('/api/desktop/upload-from-path', {
      method: 'POST',
      body: { path },
    });
    await navigateTo(`/player/${res.hash}`);
  } catch (e) {
    const err = e as { statusMessage?: string; message?: string };
    error.value = err.statusMessage ?? err.message ?? t('desktop.home.openFileFailed');
  } finally {
    isUploading.value = false;
  }
}

function onOsOpenFileEvent(e: Event): void {
  const detail = (e as CustomEvent<string>).detail;
  if (typeof detail === 'string' && detail.length > 0) {
    void handleOsOpenFile(detail);
  }
}

onMounted(() => {
  void refreshQueue();
  void refreshHealth();
  void refreshLibrary();
  void refreshDesktopSetup();
  pollHandle = setInterval(refreshQueue, 2_000);
  healthHandle = setInterval(refreshHealth, 10_000);
  window.addEventListener('subcast:open-file', onOsOpenFileEvent);
});
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  if (healthHandle) clearInterval(healthHandle);
  window.removeEventListener('subcast:open-file', onOsOpenFileEvent);
});

// i18n TODO: extract insight labels (insightLabel zh/en) into locale files
function insightLabel(lang: string | undefined): string {
  return lang === 'zh-CN' ? 'AI 总结 (中文)' : 'AI Summary (en)';
}

// Render a structured error code via i18n; fall back to the raw message
// when the code is unknown (worker emitted a code we don't have a key
// for, or the row predates the error_code column).
function friendlyTaskError(item: QueueItem): string {
  if (item.errorCode && KNOWN_ERROR_CODES.has(item.errorCode)) {
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
              <div class="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Film class="h-4 w-4" />
              </div>
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
          <ul v-else-if="queueItems.length > 0" class="space-y-1">
            <li
              v-for="item in queueItems"
              :key="`${item.kind}:${item.id}`"
              class="flex items-center justify-between gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent/50"
            >
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
              <template v-if="item.kind === 'transcribe' && item.totalChunks">
                {{ item.doneChunks }}/{{ item.totalChunks }}
              </template>
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
                    @click="cancelTask(item)"
                  >
                    <X />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t('index.cancel') }}</TooltipContent>
              </Tooltip>
            </li>
          </ul>
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
          <Button variant="secondary" @click="dialogChoose(false)">
            {{ t('companion.ignore') }}
          </Button>
          <Button @click="dialogChoose(true)">
            {{ t('companion.useExisting') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

  </AppShell>
</template>
