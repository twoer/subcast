<script setup lang="ts">
import {
  Trash2, Download, Cpu, Sliders, Database, ClipboardList, AlertTriangle,
} from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Settings {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo';
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
  displayName: string | null;
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

const { t } = useI18n();

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'] as const;

const settings = ref<Settings | null>(null);
const hardware = ref<Hardware | null>(null);
const draft = ref<Settings | null>(null);
const saving = ref(false);
const savedAt = ref<number | null>(null);
const errMsg = ref<string | null>(null);

const cache = ref<CacheResp | null>(null);

const pendingDelete = ref<CacheItem | null>(null);
const showClearAll = ref(false);

const { px: cueFontPx, load: loadCueFontSize, save: saveCueFontSize, MIN_PX: CUE_MIN, MAX_PX: CUE_MAX } = useCueListFontSize();

async function refreshCache() {
  try {
    cache.value = await $fetch<CacheResp>('/api/cache/list');
  } catch (e) {
    /* surfaced via banner indirectly */
  }
}

async function confirmDeleteOne() {
  const item = pendingDelete.value;
  if (!item) return;
  pendingDelete.value = null;
  try {
    await $fetch(`/api/cache/${item.sha256}`, { method: 'DELETE' });
    await refreshCache();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'delete failed';
  }
}

async function confirmClearAll() {
  showClearAll.value = false;
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

onMounted(async () => {
  await load();
  await refreshCache();
  loadCueFontSize();
  if (window.location.hash === '#cache') {
    nextTick(() => document.getElementById('cache')?.scrollIntoView({ behavior: 'smooth' }));
  }
});
</script>

<template>
  <main class="min-h-dvh bg-background px-8 pb-12">
    <AppHeader :show-settings-link="false" />

    <div class="mx-auto max-w-3xl">
      <header class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('settings.title') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.subtitle') }}</p>
      </header>

      <Alert v-if="errMsg" variant="destructive" class="mb-4">
        <AlertDescription>{{ errMsg }}</AlertDescription>
      </Alert>

      <section v-if="hardware" class="surface-1 mb-6 rounded-xl border border-border/50 p-6">
        <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Cpu class="h-3.5 w-3.5" />
          {{ t('settings.hardware') }}
        </h2>
        <dl class="grid grid-cols-[8rem,1fr] gap-x-4 gap-y-2.5 text-sm">
          <dt class="text-muted-foreground">{{ t('settings.tier') }}</dt>
          <dd class="font-medium">
            {{ t(`settings.tierLabels.${hardware.tier}`) }}
            <span class="ml-1.5 font-mono text-xs text-muted-foreground">({{ hardware.tier }})</span>
          </dd>
          <dt class="text-muted-foreground">{{ t('settings.ram') }}</dt>
          <dd class="font-mono">{{ hardware.totalMemoryGB }} GB</dd>
          <dt class="text-muted-foreground">{{ t('settings.cpu') }}</dt>
          <dd class="truncate" :title="hardware.cpuModel">
            <span class="font-mono">{{ hardware.cpuCount }}×</span> {{ hardware.cpuModel }}
          </dd>
          <dt class="text-muted-foreground">{{ t('settings.gpu') }}</dt>
          <dd class="truncate" :title="hardware.gpu">{{ hardware.gpu }}</dd>
          <dt class="text-muted-foreground">{{ t('settings.platform') }}</dt>
          <dd class="font-mono text-xs">{{ hardware.platform }} ({{ hardware.arch }})</dd>
          <dt class="text-muted-foreground">{{ t('settings.recommended') }}</dt>
          <dd class="font-mono text-xs">
            whisper={{ hardware.recommended.whisperModel }} · ollama={{ hardware.recommended.ollamaModel }}
          </dd>
        </dl>
        <Button
          variant="secondary"
          size="sm"
          class="mt-5"
          @click="applyRecommended"
        >{{ t('settings.applyRecommended') }}</Button>
      </section>

      <section v-if="draft" class="surface-1 space-y-6 rounded-xl border border-border/50 p-6">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Sliders class="h-3.5 w-3.5" />
          {{ t('settings.preferences') }}
        </h2>

        <div class="space-y-1.5">
          <Label class="text-sm font-medium">{{ t('settings.whisperModel') }}</Label>
          <Select v-model="draft.whisperModel">
            <SelectTrigger class="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="m in WHISPER_MODELS" :key="m" :value="m">
                <span class="font-mono">{{ m }}</span>
                <span
                  v-if="hardware && m === hardware.recommended.whisperModel"
                  class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary"
                >{{ t('settings.recommended') }}</span>
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ t('settings.whisperHint') }}</p>
        </div>

        <div class="space-y-1.5">
          <Label for="ollama-model" class="text-sm font-medium">{{ t('settings.ollamaModel') }}</Label>
          <input
            id="ollama-model"
            v-model="draft.ollamaModel"
            type="text"
            class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm ring-offset-background transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="qwen2.5:7b"
          />
          <p class="text-xs text-muted-foreground">
            {{ t('settings.ollamaHint', { model: hardware?.recommended.ollamaModel ?? '' }) }}
          </p>
        </div>

        <div class="space-y-2">
          <Label class="flex items-center justify-between text-sm font-medium">
            <span>{{ t('settings.cacheLimit') }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ draft.cacheLimitGB }} GB</span>
          </Label>
          <input
            v-model.number="draft.cacheLimitGB"
            type="range"
            min="1"
            max="100"
            step="1"
            class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
          />
        </div>

        <div class="space-y-2">
          <Label class="flex items-center justify-between text-sm font-medium">
            <span>{{ t('settings.silenceThreshold') }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ Math.round(draft.silenceThresholdMs / 1000) }}s</span>
          </Label>
          <input
            v-model.number="draft.silenceThresholdMs"
            type="range"
            min="3000"
            max="60000"
            step="1000"
            class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
          />
          <p class="text-xs text-muted-foreground">{{ t('settings.silenceHint') }}</p>
        </div>

        <div class="space-y-2">
          <Label class="flex items-center justify-between text-sm font-medium">
            <span>{{ t('settings.cueFontSize') }}</span>
            <span class="font-mono text-xs text-muted-foreground">{{ cueFontPx }}px</span>
          </Label>
          <input
            :value="cueFontPx"
            type="range"
            :min="CUE_MIN"
            :max="CUE_MAX"
            step="1"
            class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            @input="(e) => saveCueFontSize(Number((e.target as HTMLInputElement).value))"
          />
          <p class="text-xs text-muted-foreground">{{ t('settings.cueFontSizeHint') }}</p>
        </div>

        <label
          for="debug"
          class="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3 transition-colors hover:bg-muted/50"
        >
          <input
            id="debug"
            v-model="draft.debugMode"
            type="checkbox"
            class="mt-0.5 h-4 w-4 cursor-pointer rounded border-input accent-primary"
          />
          <div class="text-sm">
            <div class="font-medium leading-none">{{ t('settings.debugTitle') }}</div>
            <p class="mt-1 text-xs text-muted-foreground">{{ t('settings.debugDescription') }}</p>
          </div>
        </label>

        <div class="flex items-center gap-3 border-t border-border/50 pt-4">
          <Button
            :disabled="!dirty || saving"
            @click="save"
          >
            {{ saving ? t('settings.saving') : dirty ? t('settings.save') : t('settings.saved') }}
          </Button>
          <Button
            v-if="dirty"
            variant="ghost"
            size="sm"
            @click="draft = { ...settings! }"
          >{{ t('settings.resetDraft') }}</Button>
          <span v-if="savedAt" class="ml-auto text-xs text-muted-foreground">
            {{ t('settings.lastSaved', { time: new Date(savedAt).toLocaleTimeString() }) }}
          </span>
        </div>
      </section>

      <section id="cache" v-if="cache" class="surface-1 mt-6 rounded-xl border border-border/50 p-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Database class="h-3.5 w-3.5" />
            {{ t('settings.cache.title') }}
          </h2>
          <span class="font-mono text-xs text-muted-foreground">
            {{ t('settings.cache.totals', { count: cache.totals.count, size: fmtBytes(cache.totals.bytes) }) }}
          </span>
        </div>

        <div class="mb-5">
          <Progress
            :model-value="Math.round(cacheUsageRatio * 100)"
            class="h-2"
            :class="cacheOverThreshold ? '[&>div]:bg-destructive' : ''"
          />
          <p
            class="mt-2 flex items-center gap-1.5 text-xs"
            :class="cacheOverThreshold ? 'font-medium text-destructive' : 'text-muted-foreground'"
          >
            <AlertTriangle v-if="cacheOverThreshold" class="h-3.5 w-3.5" />
            <span class="font-mono">
              {{ fmtBytes(cache.totals.bytes) }} / {{ settings?.cacheLimitGB }} GB
              ({{ Math.round(cacheUsageRatio * 100) }}%)
            </span>
          </p>
        </div>

        <ul v-if="cache.items.length > 0" class="-mx-2 max-h-[40vh] space-y-1 overflow-y-auto px-2">
          <li
            v-for="item in cache.items"
            :key="item.sha256"
            class="group flex items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.sha256}`"
                  class="max-w-xs truncate font-medium text-foreground hover:underline"
                  :title="item.originalName"
                >{{ item.displayName || item.originalName }}</NuxtLink>
                <span class="font-mono text-[11px] text-muted-foreground">
                  {{ fmtBytes(item.videoBytes + item.cacheBytes) }}
                </span>
              </div>
              <div class="mt-0.5 text-xs text-muted-foreground">
                <template v-if="item.langs.length > 0">
                  {{ item.langs.join(' · ') }}
                </template>
                <template v-else>{{ t('settings.cache.noSubtitles') }}</template>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              class="opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
              :title="t('settings.cache.deleteOne')"
              :aria-label="t('settings.cache.deleteOne')"
              @click="pendingDelete = item"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </li>
        </ul>
        <EmptyState
          v-else
          :icon="Database"
          :title="t('settings.cache.noVideos')"
          :description="t('settings.cache.noVideosDesc')"
        />

        <div v-if="cache.totals.count > 0" class="mt-4 flex justify-end border-t border-border/50 pt-4">
          <Button
            variant="destructive"
            size="sm"
            @click="showClearAll = true"
          >
            <Trash2 class="h-4 w-4" />
            {{ t('settings.cache.clearAll') }}
          </Button>
        </div>
      </section>

      <section class="surface-1 mt-6 rounded-xl border border-border/50 p-6">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <ClipboardList class="h-3.5 w-3.5" />
              {{ t('settings.diagnostic.title') }}
            </h2>
            <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
              {{ t('settings.diagnostic.body') }}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            class="shrink-0 whitespace-nowrap"
            @click="downloadDiagnostic"
          >
            <Download class="h-4 w-4" />
            {{ t('settings.diagnostic.export') }}
          </Button>
        </div>
      </section>

      <p v-if="!hardware && !errMsg" class="mt-8 text-center text-muted-foreground">
        {{ t('settings.loading') }}
      </p>
    </div>

    <Dialog
      :open="pendingDelete !== null"
      @update:open="(v: boolean) => { if (!v) pendingDelete = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span
              class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive"
            >
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('settings.cache.deleteOneTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('settings.cache.deleteOneDesc', { name: (pendingDelete?.displayName || pendingDelete?.originalName) ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" @click="pendingDelete = null">
            {{ t('settings.cache.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmDeleteOne">
            <Trash2 class="h-4 w-4" />
            {{ t('settings.cache.confirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="showClearAll"
      @update:open="(v: boolean) => (showClearAll = v)"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span
              class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive"
            >
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('settings.cache.clearAllTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('settings.cache.clearAllDesc') }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" @click="showClearAll = false">
            {{ t('settings.cache.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmClearAll">
            <Trash2 class="h-4 w-4" />
            {{ t('settings.cache.clearAll') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </main>
</template>
