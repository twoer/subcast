<!-- app/pages/index.vue -->
<script setup lang="ts">
import { AlertCircle, Upload } from 'lucide-vue-next';

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

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard may be unavailable in non-secure context */
  }
}

async function refreshQueue() {
  try {
    const res = await $fetch<{ items: QueueItem[] }>('/api/queue/list');
    queueItems.value = res.items;
  } catch {
    /* network blip; ignore */
  }
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

const { t, locale, locales, setLocale } = useI18n();

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
  pollHandle = setInterval(refreshQueue, 2_000);
  healthHandle = setInterval(refreshHealth, 10_000);
});
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  if (healthHandle) clearInterval(healthHandle);
});

function fmtKindLabel(item: QueueItem): string {
  return item.kind === 'transcribe'
    ? `${t('index.transcribing')} · whisper:${item.model}`
    : `${t('index.translating')} · ${item.targetLang} · ${item.model}`;
}

function statusBadgeVariant(s: QueueItem['status']) {
  switch (s) {
    case 'running': return 'default';
    case 'queued': return 'secondary';
    case 'failed': return 'destructive';
    case 'canceled':
    case 'completed':
    default: return 'outline';
  }
}
</script>

<template>
  <main class="min-h-screen bg-background p-8">
    <div class="mx-auto max-w-3xl">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-3xl font-bold">{{ t('app.title') }}</h1>
        <div class="flex items-center gap-3 text-xs text-muted-foreground">
          <span v-if="healthData?.lanUrl" class="font-mono">
            {{ t('app.lan') }}: {{ healthData.lanUrl }}
          </span>
          <select
            :value="locale"
            class="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            @change="setLocale(($event.target as HTMLSelectElement).value as 'en' | 'zh')"
          >
            <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.name }}</option>
          </select>
          <NuxtLink to="/settings" class="text-primary hover:underline">{{ t('app.settings') }} →</NuxtLink>
        </div>
      </header>

      <Alert
        v-if="healthData && !healthData.health.ready"
        class="mb-6 border-amber-300 bg-amber-50 text-amber-900"
      >
        <AlertCircle class="h-4 w-4 !text-amber-800" />
        <AlertTitle class="flex items-center justify-between text-amber-900">
          <span>{{ t('health.missing') }}</span>
          <Button
            variant="ghost"
            size="sm"
            class="h-7 text-xs text-amber-900 hover:bg-amber-100"
            @click="refreshHealth"
          >{{ t('health.recheck') }}</Button>
        </AlertTitle>
        <AlertDescription>
          <ul class="mt-2 space-y-2 text-sm">
            <li v-for="fix in healthData.fixes" :key="fix.id">
              <div class="font-medium">{{ fix.description }}</div>
              <div class="mt-1 flex items-start gap-2">
                <code class="flex-1 break-all rounded bg-amber-100 px-2 py-1 font-mono text-xs">
                  {{ fix.command }}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  class="h-7 whitespace-nowrap text-xs"
                  @click="copyToClipboard(fix.command)"
                >{{ t('health.copy') }}</Button>
              </div>
            </li>
          </ul>
        </AlertDescription>
      </Alert>

      <div
        class="rounded-lg border-2 border-dashed border-input bg-card p-12 text-center transition hover:border-primary"
        @dragover.prevent
        @drop="onDrop"
      >
        <p class="mb-4 text-muted-foreground">
          {{ t('index.drop') }}
        </p>
        <Button
          :disabled="isUploading"
          @click="fileInput?.click()"
        >
          <Upload class="h-4 w-4" />
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

      <p v-if="error" class="mt-4 text-sm text-destructive">{{ error }}</p>

      <section v-if="queueItems.length > 0" class="mt-8">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm uppercase tracking-wide text-gray-700">{{ t('index.queue') }}</h2>
          <span class="text-xs text-gray-500">
            {{ t('index.queueMeta', { active: activeCount, total: queueItems.length }) }}
          </span>
        </div>
        <ul class="space-y-2">
          <li
            v-for="item in queueItems"
            :key="`${item.kind}:${item.id}`"
            class="flex items-center justify-between gap-3 rounded border bg-card p-3"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.videoSha}`"
                  class="truncate max-w-xs font-medium text-foreground hover:underline"
                  :title="item.videoName"
                >{{ item.videoName }}</NuxtLink>
                <Badge :variant="statusBadgeVariant(item.status)">
                  {{ item.status }}
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
            <div class="whitespace-nowrap text-xs text-muted-foreground">
              <template v-if="item.kind === 'transcribe' && item.totalChunks">
                {{ item.doneChunks }}/{{ item.totalChunks }} chunks
              </template>
              <template v-else-if="item.status === 'running' || item.status === 'queued'">
                {{ item.progressPct }}%
              </template>
            </div>
            <Button
              v-if="item.status === 'queued' || item.status === 'running'"
              variant="destructive"
              size="sm"
              class="h-7"
              @click="cancelTask(item)"
            >{{ t('index.cancel') }}</Button>
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
        <div class="space-y-1 rounded bg-muted p-3 font-mono text-xs">
          <div>🎬 {{ pendingPair?.video.name }}</div>
          <div>📝 {{ pendingPair?.subtitle.name }}</div>
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
  </main>
</template>
