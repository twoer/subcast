<script setup lang="ts">
import { Trash2, Download, ChevronLeft } from 'lucide-vue-next';

interface Settings {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  ollamaModel: string;
  cacheLimitGB: number;
  silenceThresholdMs: number;
  debugMode: boolean;
}
interface Hardware {
  totalMemoryGB: number;
  cpuCount: number;
  cpuModel: string;
  platform: string;
  arch: string;
  gpu: string;
  tier: 'entry' | 'standard' | 'recommended' | 'high';
  recommended: { whisperModel: string; ollamaModel: string };
  lanIp?: string;
}
interface Resp {
  settings: Settings;
  hardware: Hardware;
}

interface CacheItem {
  sha256: string;
  originalName: string;
  ext: string;
  videoBytes: number;
  cacheBytes: number;
  langs: string[];
  createdAt: number;
  lastOpenedAt: number;
}
interface CacheResp {
  items: CacheItem[];
  totals: { bytes: number; videoBytes: number; cacheBytes: number; count: number };
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const;
const TIER_LABEL: Record<Hardware['tier'], string> = {
  entry: '入门',
  standard: '标准',
  recommended: '推荐',
  high: '高配',
};

const settings = ref<Settings | null>(null);
const hardware = ref<Hardware | null>(null);
const draft = ref<Settings | null>(null);
const saving = ref(false);
const savedAt = ref<number | null>(null);
const errMsg = ref<string | null>(null);

const cache = ref<CacheResp | null>(null);

async function refreshCache() {
  try {
    cache.value = await $fetch<CacheResp>('/api/cache/list');
  } catch (e) {
    /* surfaced via banner indirectly */
  }
}

async function deleteOne(item: CacheItem) {
  if (!confirm(`Delete "${item.originalName}" and its cached subtitles?`)) return;
  try {
    await $fetch(`/api/cache/${item.sha256}`, { method: 'DELETE' });
    await refreshCache();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'delete failed';
  }
}

async function clearAll() {
  if (!confirm('Delete ALL cached videos and subtitles? This cannot be undone.')) return;
  try {
    await $fetch('/api/cache/clear', { method: 'DELETE' });
    await refreshCache();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'clear failed';
  }
}

function downloadDiagnostic() {
  // Trigger browser download via location, since fetch + blob has CORS edge
  // cases on some setups. The endpoint sets Content-Disposition.
  window.location.href = '/api/diagnostic';
}

const cacheUsageRatio = computed(() => {
  if (!cache.value || !settings.value) return 0;
  const limitBytes = settings.value.cacheLimitGB * 1_000_000_000;
  if (limitBytes <= 0) return 0;
  return Math.min(1, cache.value.totals.bytes / limitBytes);
});

const cacheOverThreshold = computed(() => cacheUsageRatio.value >= 0.9);

async function load() {
  errMsg.value = null;
  try {
    const data = await $fetch<Resp>('/api/settings');
    settings.value = data.settings;
    hardware.value = data.hardware;
    draft.value = { ...data.settings };
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'failed to load';
  }
}

async function save() {
  if (!draft.value) return;
  saving.value = true;
  errMsg.value = null;
  try {
    const data = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: draft.value,
    });
    settings.value = data.settings;
    draft.value = { ...data.settings };
    savedAt.value = Date.now();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'failed to save';
  } finally {
    saving.value = false;
  }
}

function applyRecommended() {
  if (!draft.value || !hardware.value) return;
  draft.value.whisperModel = hardware.value.recommended.whisperModel as Settings['whisperModel'];
  draft.value.ollamaModel = hardware.value.recommended.ollamaModel;
}

const dirty = computed(() => {
  if (!settings.value || !draft.value) return false;
  return JSON.stringify(settings.value) !== JSON.stringify(draft.value);
});

onMounted(() => {
  void load();
  void refreshCache();
});
</script>

<template>
  <main class="min-h-screen bg-background p-8">
    <div class="mx-auto max-w-2xl">
      <header class="mb-6 flex items-center justify-between">
        <h1 class="text-2xl font-bold">Settings</h1>
        <NuxtLink to="/" class="flex items-center gap-1 text-sm text-primary hover:underline">
          <ChevronLeft class="h-4 w-4" />
          Back
        </NuxtLink>
      </header>

      <Alert v-if="errMsg" variant="destructive" class="mb-4">
        <AlertDescription>{{ errMsg }}</AlertDescription>
      </Alert>

      <section v-if="hardware" class="mb-6 rounded border bg-card p-5">
        <h2 class="mb-3 text-sm uppercase tracking-wide text-muted-foreground">Hardware</h2>
        <dl class="grid grid-cols-2 gap-y-1.5 text-sm">
          <dt class="text-gray-500">Tier</dt>
          <dd class="font-medium">
            {{ TIER_LABEL[hardware.tier] }}
            <span class="text-xs text-gray-500 ml-2">({{ hardware.tier }})</span>
          </dd>
          <dt class="text-gray-500">RAM</dt>
          <dd>{{ hardware.totalMemoryGB }} GB</dd>
          <dt class="text-gray-500">CPU</dt>
          <dd class="truncate" :title="hardware.cpuModel">
            {{ hardware.cpuCount }}× {{ hardware.cpuModel }}
          </dd>
          <dt class="text-gray-500">GPU</dt>
          <dd>{{ hardware.gpu }}</dd>
          <dt class="text-gray-500">Platform</dt>
          <dd>{{ hardware.platform }} ({{ hardware.arch }})</dd>
          <dt class="text-gray-500">Recommended</dt>
          <dd class="text-xs font-mono">
            whisper={{ hardware.recommended.whisperModel }} · ollama={{ hardware.recommended.ollamaModel }}
          </dd>
        </dl>
        <Button
          variant="secondary"
          size="sm"
          class="mt-4"
          @click="applyRecommended"
        >Apply recommended → draft</Button>
      </section>

      <section v-if="draft" class="space-y-5 rounded border bg-card p-5">
        <h2 class="text-sm uppercase tracking-wide text-muted-foreground">Settings</h2>

        <div>
          <Label class="mb-1 block text-sm font-medium">Whisper model</Label>
          <select
            v-model="draft.whisperModel"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option v-for="m in WHISPER_MODELS" :key="m" :value="m">
              {{ m }}
              <template v-if="hardware && m === hardware.recommended.whisperModel">
                ← recommended
              </template>
            </option>
          </select>
          <p class="mt-1 text-xs text-muted-foreground">
            Bigger = more accurate but slower. Changes apply to new transcribe tasks.
          </p>
        </div>

        <div>
          <Label class="mb-1 block text-sm font-medium">Ollama model</Label>
          <input
            v-model="draft.ollamaModel"
            type="text"
            class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="qwen2.5:7b"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            Use the exact tag visible in <code>ollama list</code>. Recommended:
            <code>{{ hardware?.recommended.ollamaModel }}</code>.
          </p>
        </div>

        <div>
          <Label class="mb-1 block text-sm font-medium">
            Cache size limit
            <span class="ml-2 text-muted-foreground">{{ draft.cacheLimitGB }} GB</span>
          </Label>
          <input
            v-model.number="draft.cacheLimitGB"
            type="range"
            min="1"
            max="100"
            step="1"
            class="w-full accent-primary"
          />
        </div>

        <div>
          <Label class="mb-1 block text-sm font-medium">
            Silence threshold
            <span class="ml-2 text-muted-foreground">{{ Math.round(draft.silenceThresholdMs / 1000) }}s</span>
          </Label>
          <input
            v-model.number="draft.silenceThresholdMs"
            type="range"
            min="3000"
            max="60000"
            step="1000"
            class="w-full accent-primary"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            Inter-cue gaps ≥ this duration get a 「── 无语音 ──」divider in the cue list.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <input
            id="debug"
            v-model="draft.debugMode"
            type="checkbox"
            class="h-4 w-4 rounded border-input accent-primary"
          />
          <Label for="debug" class="text-sm font-normal">
            Debug mode (keep raw paths/filenames in JSONL logs)
          </Label>
        </div>

        <div class="flex items-center gap-3 border-t pt-3">
          <Button
            :disabled="!dirty || saving"
            @click="save"
          >
            {{ saving ? 'Saving…' : dirty ? 'Save' : 'Saved' }}
          </Button>
          <Button
            v-if="dirty"
            variant="ghost"
            size="sm"
            @click="draft = { ...settings! }"
          >Reset</Button>
          <span v-if="savedAt" class="text-xs text-muted-foreground">
            Last saved: {{ new Date(savedAt).toLocaleTimeString() }}
          </span>
        </div>
      </section>

      <section v-if="cache" class="mt-6 rounded border bg-card p-5">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm uppercase tracking-wide text-muted-foreground">Cache</h2>
          <span class="text-xs text-muted-foreground">
            {{ cache.totals.count }} videos · {{ fmtBytes(cache.totals.bytes) }} total
          </span>
        </div>

        <div class="mb-4">
          <Progress
            :model-value="Math.round(cacheUsageRatio * 100)"
            class="h-2"
            :class="cacheOverThreshold ? '[&>div]:bg-destructive' : ''"
          />
          <p
            class="mt-1 text-xs"
            :class="cacheOverThreshold ? 'font-medium text-destructive' : 'text-muted-foreground'"
          >
            <template v-if="cacheOverThreshold">⚠️ </template>
            {{ fmtBytes(cache.totals.bytes) }} / {{ settings?.cacheLimitGB }} GB
            ({{ Math.round(cacheUsageRatio * 100) }}%)
          </p>
        </div>

        <ul v-if="cache.items.length > 0" class="max-h-[40vh] space-y-2 overflow-y-auto">
          <li
            v-for="item in cache.items"
            :key="item.sha256"
            class="flex items-center justify-between gap-3 border-b py-2"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.sha256}`"
                  class="truncate max-w-xs font-medium hover:underline"
                  :title="item.originalName"
                >{{ item.originalName }}</NuxtLink>
                <span class="text-xs text-muted-foreground">
                  {{ fmtBytes(item.videoBytes + item.cacheBytes) }}
                </span>
              </div>
              <div class="mt-0.5 text-xs text-muted-foreground">
                <template v-if="item.langs.length > 0">
                  {{ item.langs.join(' · ') }}
                </template>
                <template v-else>(no subtitles)</template>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="deleteOne(item)"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </li>
        </ul>
        <p v-else class="py-3 text-center text-sm text-muted-foreground">
          No cached videos yet.
        </p>

        <div class="mt-3 flex justify-end border-t pt-3">
          <Button
            v-if="cache.totals.count > 0"
            variant="destructive"
            size="sm"
            @click="clearAll"
          >
            <Trash2 class="h-4 w-4" />
            Clear all
          </Button>
        </div>
      </section>

      <section class="mt-6 rounded border bg-card p-5">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-sm uppercase tracking-wide text-muted-foreground">Diagnostic</h2>
            <p class="mt-1 text-xs text-muted-foreground">
              ZIP with sanitized JSONL logs (last 7d), settings, hardware info,
              installed models. No video content or cue text.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            class="whitespace-nowrap"
            @click="downloadDiagnostic"
          >
            <Download class="h-4 w-4" />
            Export ZIP
          </Button>
        </div>
      </section>

      <p v-if="!hardware && !errMsg" class="mt-8 text-center text-muted-foreground">
        Loading hardware info…
      </p>
    </div>
  </main>
</template>
