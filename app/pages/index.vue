<!-- app/pages/index.vue -->
<script setup lang="ts">
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
</script>

<template>
  <main class="min-h-screen p-8 bg-gray-50">
    <div class="max-w-3xl mx-auto">
      <header class="flex items-center justify-between mb-6">
        <h1 class="text-3xl font-bold">{{ t('app.title') }}</h1>
        <div class="flex items-center gap-3 text-xs text-gray-500">
          <span v-if="healthData?.lanUrl" class="font-mono">
            {{ t('app.lan') }}: {{ healthData.lanUrl }}
          </span>
          <select
            :value="locale"
            class="bg-white border border-gray-300 rounded px-2 py-1 text-xs"
            @change="setLocale(($event.target as HTMLSelectElement).value as 'en' | 'zh')"
          >
            <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.name }}</option>
          </select>
          <NuxtLink to="/settings" class="text-blue-600 hover:underline">{{ t('app.settings') }} →</NuxtLink>
        </div>
      </header>

      <div
        v-if="healthData && !healthData.health.ready"
        class="mb-6 bg-amber-50 border border-amber-300 rounded p-4"
      >
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-amber-900">
            {{ t('health.missing') }}
          </h2>
          <button
            class="text-xs text-amber-800 hover:underline"
            @click="refreshHealth"
          >{{ t('health.recheck') }}</button>
        </div>
        <ul class="space-y-2 text-sm">
          <li v-for="fix in healthData.fixes" :key="fix.id" class="text-amber-900">
            <div class="font-medium">{{ fix.description }}</div>
            <div class="flex gap-2 items-start mt-1">
              <code class="flex-1 bg-amber-100 rounded px-2 py-1 text-xs font-mono break-all">{{ fix.command }}</code>
              <button
                class="text-xs px-2 py-1 rounded bg-amber-200 hover:bg-amber-300 whitespace-nowrap"
                @click="copyToClipboard(fix.command)"
              >{{ t('health.copy') }}</button>
            </div>
          </li>
        </ul>
      </div>

      <div
        class="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center bg-white hover:border-blue-400 transition"
        @dragover.prevent
        @drop="onDrop"
      >
        <p class="mb-4 text-gray-600">
          {{ t('index.drop') }}
        </p>
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="isUploading"
          @click="fileInput?.click()"
        >
          {{ isUploading ? t('index.uploading') : t('index.choose') }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="video/*,audio/*,.srt,.vtt,.ass"
          multiple
          class="hidden"
          @change="onPickFile"
        />
      </div>

      <p v-if="error" class="mt-4 text-red-600 text-sm">{{ error }}</p>

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
            class="bg-white rounded p-3 flex items-center justify-between gap-3 border border-gray-200"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.videoSha}`"
                  class="font-medium text-gray-900 hover:underline truncate max-w-xs"
                  :title="item.videoName"
                >{{ item.videoName }}</NuxtLink>
                <span
                  class="px-1.5 py-0.5 rounded text-xs"
                  :class="{
                    'bg-yellow-100 text-yellow-800': item.status === 'running',
                    'bg-blue-100 text-blue-800': item.status === 'queued',
                    'bg-green-100 text-green-800': item.status === 'completed',
                    'bg-red-100 text-red-800': item.status === 'failed',
                    'bg-gray-200 text-gray-700': item.status === 'canceled',
                  }"
                >{{ item.status }}</span>
              </div>
              <div class="text-xs text-gray-500 mt-1">{{ fmtKindLabel(item) }}</div>
              <div
                v-if="item.status === 'running' || item.status === 'queued'"
                class="mt-2 h-1.5 w-full bg-gray-200 rounded overflow-hidden"
              >
                <div
                  class="h-full bg-blue-500 transition-all"
                  :style="{ width: `${item.progressPct}%` }"
                ></div>
              </div>
              <p
                v-if="item.errorMsg"
                class="text-xs text-red-600 mt-1 truncate"
                :title="item.errorMsg"
              >{{ item.errorMsg }}</p>
            </div>
            <div class="text-xs text-gray-500 whitespace-nowrap">
              <template v-if="item.kind === 'transcribe' && item.totalChunks">
                {{ item.doneChunks }}/{{ item.totalChunks }} chunks
              </template>
              <template v-else-if="item.status === 'running' || item.status === 'queued'">
                {{ item.progressPct }}%
              </template>
            </div>
            <button
              v-if="item.status === 'queued' || item.status === 'running'"
              class="text-xs px-2 py-1 rounded bg-red-50 text-red-700 hover:bg-red-100"
              @click="cancelTask(item)"
            >{{ t('index.cancel') }}</button>
          </li>
        </ul>
      </section>
    </div>

    <div
      v-if="pendingPair"
      class="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      @click.self="dialogChoose(false)"
    >
      <div class="bg-white rounded-lg p-6 w-full max-w-md">
        <h3 class="text-lg font-semibold mb-3">{{ t('companion.title') }}</h3>
        <p class="text-sm text-gray-700 mb-4">
          {{ t('companion.body') }}
        </p>
        <div class="bg-gray-50 rounded p-3 text-xs font-mono mb-4 space-y-1">
          <div>🎬 {{ pendingPair.video.name }}</div>
          <div>📝 {{ pendingPair.subtitle.name }}</div>
        </div>
        <div class="flex gap-2 justify-end">
          <button
            class="px-3 py-1.5 text-sm rounded bg-gray-200 hover:bg-gray-300"
            @click="dialogChoose(false)"
          >{{ t('companion.ignore') }}</button>
          <button
            class="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
            @click="dialogChoose(true)"
          >{{ t('companion.useExisting') }}</button>
        </div>
      </div>
    </div>
  </main>
</template>
