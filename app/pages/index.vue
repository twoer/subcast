<!-- app/pages/index.vue -->
<script setup lang="ts">
import { AlertCircle, Check, Upload, ListVideo, X, Film, FileText, History, Pencil } from 'lucide-vue-next';

interface QueueItem {
  kind: 'transcribe' | 'translate';
  id: string;
  videoSha: string;
  videoName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  model: string;
  progressPct: number;
  totalChunks?: number | null;
  doneChunks?: number;
  targetLang?: string;
  createdAt: number;
  errorMsg?: string | null;
}

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

const renameItem = ref<CacheEntry | null>(null);
const renameValue = ref('');
const renameSaving = ref(false);

function openRename(item: CacheEntry) {
  renameItem.value = item;
  renameValue.value = item.displayName ?? item.originalName;
  renameSaving.value = false;
}

async function confirmRename() {
  const item = renameItem.value;
  if (!item) return;
  renameSaving.value = true;
  const name = renameValue.value.trim();
  const displayName = name || null;
  try {
    await $fetch(`/api/cache/${item.sha256}`, {
      method: 'PATCH',
      body: { displayName },
    });
    item.displayName = displayName;
  } catch { /* refresh will reconcile */ }
  renameItem.value = null;
}

const queueItems = ref<QueueItem[]>([]);
const healthData = ref<HealthResp | null>(null);
let pollHandle: ReturnType<typeof setInterval> | null = null;
let healthHandle: ReturnType<typeof setInterval> | null = null;

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
  } catch {
    /* network blip; ignore */
  }
}

async function refreshLibrary() {
  try {
    const res = await $fetch<{ items: CacheEntry[] }>('/api/cache/list');
    cachedVideos.value = res.items.slice(0, 15);
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

onMounted(() => {
  void refreshQueue();
  void refreshHealth();
  void refreshLibrary();
  pollHandle = setInterval(refreshQueue, 2_000);
  healthHandle = setInterval(refreshHealth, 10_000);
});
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  if (healthHandle) clearInterval(healthHandle);
});

function fmtKindLabel(item: QueueItem): string {
  const active = item.status === 'queued' || item.status === 'running';
  const prefix = item.kind === 'transcribe'
    ? active ? t('index.transcribing') : t('index.status.completed')
    : active ? t('index.translating') : t('index.status.completed');
  return item.kind === 'transcribe'
    ? `${prefix} · whisper:${item.model}`
    : `${prefix} · ${item.targetLang} · ${item.model}`;
}

function statusBadgeVariant(s: QueueItem['status']) {
  switch (s) {
    case 'running': return 'default';
    case 'queued': return 'secondary';
    case 'failed': return 'destructive';
    case 'completed':
    case 'canceled':
    default: return 'outline';
  }
}

function statusBadgeClass(s: QueueItem['status']) {
  switch (s) {
    case 'running':
      return 'bg-primary/10 text-primary border-transparent hover:bg-primary/15';
    case 'completed':
      return 'border-success/40 bg-success/10 text-success';
    case 'failed':
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
  <main class="min-h-dvh bg-background px-8 pb-12">
    <AppHeader :lan-url="healthData?.lanUrl" />

    <div class="mx-auto max-w-3xl">

      <div
        v-if="healthData && !healthData.health.ready"
        class="surface-1 mb-6 overflow-hidden rounded-xl border border-warning/20"
      >
        <div class="flex items-center gap-2.5 border-b border-warning/10 bg-warning/[0.04] px-4 py-3 dark:bg-warning/[0.06]">
          <AlertCircle class="h-4 w-4 shrink-0 text-warning" />
          <span class="flex-1 text-sm font-medium text-foreground">{{ t('health.missing') }}</span>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
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
        />
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
            to="/settings#cache"
            class="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >{{ t('index.library.more') }}</NuxtLink>
        </div>
        <ul class="space-y-1.5">
          <li
            v-for="item in cachedVideos"
            :key="item.sha256"
            class="surface-1 group/row flex items-center gap-3 rounded-lg border px-3.5 py-3 transition-colors hover:bg-accent/40"
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
                <button
                  class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100"
                  :title="t('index.library.rename')"
                  @click.prevent="openRename(item)"
                >
                  <Pencil class="h-3 w-3" />
                </button>
              </div>
              <div class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{{ item.langs.length > 0 ? item.langs.join(' · ') : t('index.library.noSubs') }}</span>
                <span class="text-border">·</span>
                <span class="font-mono">{{ fmtBytes(item.videoBytes + item.cacheBytes) }}</span>
              </div>
            </div>
            <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
              {{ fmtTimeAgo(item.lastOpenedAt) }}
            </span>
          </li>
        </ul>
      </section>

      <section v-if="queueItems.length > 0" class="mt-10">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <ListVideo class="h-3.5 w-3.5" />
            {{ t('index.queue') }}
          </h2>
          <span class="font-mono text-xs text-muted-foreground">
            {{ t('index.queueMeta', { active: activeCount, total: queueItems.length }) }}
          </span>
        </div>
        <ul class="space-y-2">
          <li
            v-for="item in queueItems"
            :key="`${item.kind}:${item.id}`"
            class="surface-1 flex items-center justify-between gap-3 rounded-lg border p-3.5 transition-colors hover:bg-accent/40"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.videoSha}`"
                  class="max-w-xs truncate font-medium text-foreground hover:underline"
                  :title="item.videoName"
                >{{ item.videoName }}</NuxtLink>
                <Badge variant="outline" :class="statusBadgeClass(item.status)">
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
                v-if="item.errorMsg"
                class="mt-1 truncate text-xs text-destructive"
                :title="item.errorMsg"
              >{{ item.errorMsg }}</p>
            </div>
            <div class="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
              <template v-if="item.kind === 'transcribe' && item.totalChunks">
                {{ item.doneChunks }}/{{ item.totalChunks }}
              </template>
              <template v-else-if="item.status === 'running' || item.status === 'queued'">
                {{ item.progressPct }}%
              </template>
            </div>
            <Button
              v-if="item.status === 'queued' || item.status === 'running'"
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              :title="t('index.cancel')"
              :aria-label="t('index.cancel')"
              @click="cancelTask(item)"
            >
              <X class="h-4 w-4" />
            </Button>
          </li>
        </ul>
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

    <Dialog
      :open="renameItem !== null"
      @update:open="(v: boolean) => { if (!v) renameItem = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('index.library.rename') }}</DialogTitle>
          <DialogDescription>{{ t('index.library.renameDesc') }}</DialogDescription>
        </DialogHeader>
        <input
          v-model="renameValue"
          type="text"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          :placeholder="renameItem?.originalName"
          @keydown.enter="confirmRename"
        />
        <DialogFooter>
          <Button variant="secondary" @click="renameItem = null">
            {{ t('index.library.cancel') }}
          </Button>
          <Button :disabled="renameSaving" @click="confirmRename">
            {{ t('index.library.renameConfirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </main>
</template>
