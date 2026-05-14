<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import {
  Download, Cpu, Sliders, ClipboardList, Boxes, Plus,
  HelpCircle, LayoutDashboard, Wrench, RefreshCw, ExternalLink, ChevronRight,
  Trash2, AlertTriangle, CheckCircle2, Info,
} from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WHISPER_MODEL_NAMES, type WhisperModelName } from '#shared/whisperModels';
import { LLM_MODELS, type LlmModelId } from '../../desktop/modelManager/llmConfig';
import { Badge } from '~/components/ui/badge';

interface Settings {
  whisperModel: WhisperModelName;
  llmModel: LlmModelId | undefined;
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
  recommended: { whisperModel: string; llmModel: LlmModelId };
  lanIp?: string;
}
interface Resp {
  settings: Settings;
  hardware: Hardware;
}

const { t } = useI18n();
const desktop = useDesktop();
const { set: setActiveModelsCache, refresh: refreshActiveModels } = useActiveModels();

const WHISPER_MODELS = WHISPER_MODEL_NAMES;
const LLM_MODEL_IDS = Object.keys(LLM_MODELS) as LlmModelId[];

const settings = ref<Settings | null>(null);
const hardware = ref<Hardware | null>(null);
const draft = ref<Settings | null>(null);
const saving = ref(false);
const savedAt = ref<number | null>(null);
const errMsg = ref<string | null>(null);

const { px: cueFontPx, load: loadCueFontSize, save: saveCueFontSize, MIN_PX: CUE_MIN, MAX_PX: CUE_MAX } = useCueListFontSize();

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} KB`;
  return `${n} B`;
}

// All tab ids, plus a computed visible list that hides desktop-only tabs
// in the web build. `models` is the only desktop-gated tab today.
type TabId = 'overview' | 'preferences' | 'models' | 'diagnostics' | 'help' | 'about';

const TABS = computed<Array<{ id: TabId; labelKey: string; icon: typeof Cpu }>>(() => {
  const all: Array<{ id: TabId; labelKey: string; icon: typeof Cpu }> = [
    { id: 'overview',    labelKey: 'settings.tabs.overview',    icon: LayoutDashboard },
    { id: 'preferences', labelKey: 'settings.tabs.preferences', icon: Sliders },
    { id: 'models',      labelKey: 'settings.tabs.models',      icon: Boxes },
    { id: 'diagnostics', labelKey: 'settings.tabs.diagnostics', icon: ClipboardList },
    { id: 'help',        labelKey: 'settings.tabs.help',        icon: HelpCircle },
    { id: 'about',       labelKey: 'settings.tabs.about',       icon: Info },
  ];
  return all.filter((t) => (t.id === 'models' ? desktop.isDesktop : true));
});

const currentTab = ref<TabId>('overview');

function isVisibleTab(s: string): s is TabId {
  return TABS.value.some((t) => t.id === s);
}

function syncFromHash(): void {
  if (typeof window === 'undefined') return;
  const h = window.location.hash.slice(1);
  if (isVisibleTab(h)) currentTab.value = h;
}

function onTabChange(value: string | number): void {
  const v = String(value);
  if (!isVisibleTab(v)) return;
  currentTab.value = v;
  if (typeof window !== 'undefined' && window.location.hash !== `#${v}`) {
    window.history.replaceState(null, '', `#${v}`);
  }
}

// ── Models tab state ────────────────────────────────────────────────
interface WhisperModelRow { name: string; sizeBytes: number }
interface LlmModelRow { name: LlmModelId; filename: string; sizeBytes: number }
interface ModelsResp {
  whisper: { active: string; installed: WhisperModelRow[] };
  llm: { active: LlmModelId | undefined; installed: LlmModelRow[] };
}

const modelsData = ref<ModelsResp | null>(null);
const modelsLoading = ref(false);
const modelsErr = ref<string | null>(null);

const installedWhisperNames = computed<Set<string>>(
  () => new Set(modelsData.value?.whisper.installed.map((m) => m.name) ?? []),
);

function getLlmFilename(id: LlmModelId): string {
  return LLM_MODELS[id].filename;
}

type DeleteTarget =
  | { kind: 'whisper'; name: string; sizeBytes: number }
  | { kind: 'llm'; name: LlmModelId; sizeBytes: number };
const pendingDelete = ref<DeleteTarget | null>(null);

async function loadModels(): Promise<void> {
  if (!desktop.isDesktop) return;
  modelsLoading.value = true;
  modelsErr.value = null;
  try {
    modelsData.value = await $fetch<ModelsResp>('/api/desktop/models');
  } catch (e) {
    modelsErr.value = e instanceof Error ? e.message : 'failed to load models';
  } finally {
    modelsLoading.value = false;
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
    setActiveModelsCache(res.settings.whisperModel, res.settings.llmModel);
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
    setActiveModelsCache(res.settings.whisperModel, res.settings.llmModel);
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

// Help tab content (mirrored from the former /help page).
const REPO_URL = 'https://github.com/twoer/subcast';
const DOCS_URL = 'https://github.com/twoer/subcast#readme';
const ISSUES_URL = 'https://github.com/twoer/subcast/issues/new';
const LICENSE_URL = 'https://github.com/twoer/subcast/blob/main/LICENSE';

interface FaqItem {
  titleKey: string;
  bodyKey: string;
}
const FAQ: FaqItem[] = [
  { titleKey: 'desktop.help.faq.mirrorTitle', bodyKey: 'desktop.help.faq.mirrorBody' },
  { titleKey: 'desktop.help.faq.macGatekeeperTitle', bodyKey: 'desktop.help.faq.macGatekeeperBody' },
  { titleKey: 'desktop.help.faq.zombieTitle', bodyKey: 'desktop.help.faq.zombieBody' },
];

// About tab content. Moved here from app/pages/about.vue + the separate
// Electron BrowserWindow it used to live in — that window ran its own
// Nuxt instance so the in-app locale toggle didn't propagate to it.
// Hosting About as a Settings tab means vue-i18n state is shared with
// the rest of the app, and language switches Just Work.
const appVersion = computed<string>(() => desktop.appVersion ?? '0.1.0');
const aboutDependencies: Array<{ name: string; version: string; license: string }> = [
  { name: 'Whisper.cpp', version: 'v1.8.x', license: 'MIT' },
  { name: 'llama.cpp', version: 'bundled', license: 'MIT' },
  { name: 'ffmpeg-static', version: 'LGPL build', license: 'LGPL' },
  { name: 'Electron', version: 'v36.x', license: 'MIT' },
  { name: 'Nuxt 4 · Vue 3', version: 'latest', license: 'MIT' },
];

function downloadDiagnostic() {
  // Trigger browser download via location, since fetch + blob has CORS edge
  // cases on some setups. The endpoint sets Content-Disposition.
  window.location.href = '/api/diagnostic';
}

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

/** Generic PUT helper — both saveActiveModels and savePreferences share it. */
async function saveSlice(slice: Partial<Settings>): Promise<void> {
  if (!draft.value) return;
  saving.value = true;
  errMsg.value = null;
  try {
    const data = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: slice,
    });
    settings.value = data.settings;
    draft.value = { ...data.settings };
    savedAt.value = Date.now();
    setActiveModelsCache(data.settings.whisperModel, data.settings.llmModel);
    void refreshActiveModels();
    if (modelsData.value) {
      modelsData.value.whisper.active = data.settings.whisperModel;
      modelsData.value.llm.active = data.settings.llmModel;
    }
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'failed to save';
  } finally {
    saving.value = false;
  }
}

async function saveActiveModels(): Promise<void> {
  if (!draft.value) return;
  await saveSlice({
    whisperModel: draft.value.whisperModel,
    llmModel: draft.value.llmModel,
  });
}

async function savePreferences(): Promise<void> {
  if (!draft.value) return;
  await saveSlice({
    cacheLimitGB: draft.value.cacheLimitGB,
    silenceThresholdMs: draft.value.silenceThresholdMs,
    debugMode: draft.value.debugMode,
  });
}

function applyRecommended() {
  if (!draft.value || !hardware.value) return;
  draft.value.whisperModel = hardware.value.recommended.whisperModel as Settings['whisperModel'];
  draft.value.llmModel = hardware.value.recommended.llmModel;
}

function resetActiveModelsDraft(): void {
  if (!draft.value || !settings.value) return;
  draft.value.whisperModel = settings.value.whisperModel;
  draft.value.llmModel = settings.value.llmModel;
}

const dirtyModels = computed(() => {
  if (!settings.value || !draft.value) return false;
  return (
    draft.value.whisperModel !== settings.value.whisperModel
    || draft.value.llmModel !== settings.value.llmModel
  );
});

const dirtyPrefs = computed(() => {
  if (!settings.value || !draft.value) return false;
  return (
    draft.value.cacheLimitGB !== settings.value.cacheLimitGB
    || draft.value.silenceThresholdMs !== settings.value.silenceThresholdMs
    || draft.value.debugMode !== settings.value.debugMode
  );
});

// In-app hash navigation (e.g. menu → /settings#about) uses vue-router
// push, which goes through history.pushState — and pushState by spec
// does NOT fire `hashchange`. The native `hashchange` listener below
// still catches external hash mutations (deep-link reloads, manual URL
// edits); this watcher covers programmatic same-route navigation.
const route = useRoute();
watch(() => route.hash, syncFromHash);

onMounted(async () => {
  await load();
  loadCueFontSize();
  syncFromHash();
  window.addEventListener('hashchange', syncFromHash);
  if (desktop.isDesktop) void loadModels();
});
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', syncFromHash);
});
</script>

<template>
  <AppShell>
    <template #header>
      <AppHeader :show-settings-link="false" />
    </template>

    <div class="mx-auto w-full max-w-screen-2xl px-4">
      <header class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('settings.title') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.subtitle') }}</p>
      </header>

      <Alert v-if="errMsg" variant="destructive" class="mb-4">
        <AlertDescription>{{ errMsg }}</AlertDescription>
      </Alert>

      <Tabs
        :model-value="currentTab"
        orientation="vertical"
        class="gap-6 md:grid md:grid-cols-[14rem,1fr] md:gap-8"
        @update:model-value="onTabChange"
      >
        <TabsList
          class="mb-6 inline-flex h-auto w-full flex-wrap items-stretch justify-start gap-1 rounded-lg bg-muted/40 p-1 md:mb-0 md:flex-col md:gap-0.5 md:bg-transparent md:p-0"
        >
          <TabsTrigger
            v-for="tab in TABS"
            :key="tab.id"
            :value="tab.id"
            class="h-9 justify-start gap-2 px-3 text-muted-foreground data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none md:w-full"
          >
            <component :is="tab.icon" class="h-3.5 w-3.5" />
            {{ t(tab.labelKey) }}
          </TabsTrigger>
        </TabsList>

        <div class="min-w-0">
          <TabsContent value="overview" class="mt-0 focus-visible:outline-none">
            <section v-if="hardware" class="card">
              <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Cpu class="h-3.5 w-3.5" />
                {{ t('settings.hardware') }}
              </h2>
              <dl class="grid grid-cols-[8rem,1fr] gap-x-4 gap-y-2.5 text-sm">
                <dt class="text-muted-foreground">{{ t('settings.tier') }}</dt>
                <dd class="font-medium">
                  {{ t(`settings.tierLabels.${hardware.tier}`) }}
                  <span class="ml-1.5 text-xs text-muted-foreground">({{ hardware.tier }})</span>
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
                  whisper={{ hardware.recommended.whisperModel }} · llm={{ hardware.recommended.llmModel }}
                </dd>
              </dl>
              <Button
                variant="secondary"
                size="sm"
                class="mt-5"
                @click="applyRecommended"
              >{{ t('settings.applyRecommended') }}</Button>
            </section>
            <p v-else-if="!errMsg" class="mt-8 text-center text-muted-foreground">
              {{ t('settings.loading') }}
            </p>
          </TabsContent>

          <TabsContent value="preferences" class="mt-0 focus-visible:outline-none">
            <section v-if="draft" class="card space-y-6">
              <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Sliders class="h-3.5 w-3.5" />
                {{ t('settings.preferences') }}
              </h2>

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
                >
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
                >
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
                >
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
                >
                <div class="text-sm">
                  <div class="font-medium leading-none">{{ t('settings.debugTitle') }}</div>
                  <p class="mt-1 text-xs text-muted-foreground">{{ t('settings.debugDescription') }}</p>
                </div>
              </label>

              <div class="flex items-center gap-3 border-t border-border/50 pt-4">
                <Button
                  :disabled="!dirtyPrefs || saving"
                  @click="savePreferences"
                >
                  {{ saving ? t('settings.saving') : dirtyPrefs ? t('settings.save') : t('settings.saved') }}
                </Button>
                <Button
                  v-if="dirtyPrefs"
                  variant="ghost"
                  size="sm"
                  @click="(draft = { ...settings! })"
                >{{ t('settings.resetDraft') }}</Button>
                <span v-if="savedAt" class="ml-auto text-xs text-muted-foreground">
                  {{ t('settings.lastSaved', { time: new Date(savedAt).toLocaleTimeString() }) }}
                </span>
              </div>
            </section>
          </TabsContent>

          <TabsContent v-if="desktop.isDesktop" value="models" class="mt-0 space-y-6 focus-visible:outline-none">
            <Alert v-if="modelsErr" variant="destructive">
              <AlertDescription>{{ modelsErr }}</AlertDescription>
            </Alert>

            <section v-if="draft" class="card space-y-5">
              <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <CheckCircle2 class="h-3.5 w-3.5" />
                {{ t('settings.models.activeTitle') }}
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
                        class="ml-2 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
                      >{{ t('settings.recommended') }}</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ t('settings.whisperHint') }}</p>
                <Alert
                  v-if="modelsData && !installedWhisperNames.has(draft.whisperModel)"
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
                    <SelectValue :placeholder="t('settings.models.notConfigured')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="id in LLM_MODEL_IDS" :key="id" :value="id">
                      <span class="font-mono">{{ id }}</span>
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
              </div>

              <div class="flex items-center gap-3 border-t border-border/50 pt-4">
                <Button
                  :disabled="!dirtyModels || saving"
                  @click="saveActiveModels"
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
                    <span
                      v-if="m.name === modelsData.whisper.active"
                      class="inline-flex items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wider text-primary"
                    >
                      <CheckCircle2 class="h-3 w-3" />
                      {{ t('settings.models.active') }}
                    </span>
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
                  {{ t('settings.models.llm') }}
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
                    to="/setup-wizard?step=2"
                    class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    <Plus class="h-3.5 w-3.5" />
                    {{ t('settings.models.downloadMore') }}
                  </NuxtLink>
                </div>
              </div>

              <p v-if="modelsData?.llm" class="mb-3 text-xs text-muted-foreground">
                {{
                  modelsData.llm.active
                    ? t('settings.models.activeFile', { name: getLlmFilename(modelsData.llm.active) })
                    : t('settings.models.notConfigured')
                }}
              </p>

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
                    <span class="truncate font-mono text-sm font-medium text-foreground">{{ m.filename }}</span>
                    <span class="font-mono text-xs text-muted-foreground">{{ fmtBytes(m.sizeBytes) }}</span>
                    <Badge
                      v-if="m.name === modelsData.llm.active"
                      variant="secondary"
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
            </section>
          </TabsContent>

          <TabsContent value="diagnostics" class="mt-0 space-y-6 focus-visible:outline-none">
            <section class="card">
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

            <LogViewer v-if="desktop.isDesktop" />
          </TabsContent>

          <TabsContent value="help" class="mt-0 space-y-6 focus-visible:outline-none">
            <p class="text-sm text-muted-foreground">{{ t('desktop.help.introBody') }}</p>

            <section class="card">
              <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Download class="h-3.5 w-3.5" />
                {{ t('desktop.help.diagnostics.title') }}
              </h2>
              <p class="text-sm text-foreground">{{ t('desktop.help.diagnostics.body') }}</p>
            </section>

            <section class="card">
              <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <RefreshCw class="h-3.5 w-3.5" />
                {{ t('desktop.help.updates.title') }}
              </h2>
              <ul class="space-y-2 text-sm text-foreground">
                <li>· {{ t('desktop.help.updates.windowsBody') }}</li>
                <li>· {{ t('desktop.help.updates.macBody') }}</li>
              </ul>
            </section>

            <section class="card">
              <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Wrench class="h-3.5 w-3.5" />
                {{ t('desktop.help.faq.title') }}
              </h2>
              <div class="space-y-2">
                <details
                  v-for="item in FAQ"
                  :key="item.titleKey"
                  class="group rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                >
                  <summary class="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground marker:hidden [&::-webkit-details-marker]:hidden">
                    <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90" />
                    <span class="flex-1">{{ t(item.titleKey) }}</span>
                  </summary>
                  <p class="mt-2 pl-6 text-muted-foreground">{{ t(item.bodyKey) }}</p>
                </details>
              </div>
            </section>

            <section class="card">
              <h2 class="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ExternalLink class="h-3.5 w-3.5" />
                {{ t('desktop.help.links.docs') }}
              </h2>
              <div class="flex flex-wrap gap-2">
                <a
                  :href="DOCS_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <ExternalLink class="h-3 w-3 opacity-70" />
                  {{ t('desktop.help.links.docs') }}
                </a>
                <a
                  :href="REPO_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <ExternalLink class="h-3 w-3 opacity-70" />
                  {{ t('desktop.help.links.repository') }}
                </a>
                <a
                  :href="ISSUES_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <ExternalLink class="h-3 w-3 opacity-70" />
                  {{ t('desktop.help.links.reportIssue') }}
                </a>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="about" class="mt-0 focus-visible:outline-none">
            <section class="card flex flex-col items-center text-center">
              <img src="/favicon.svg" alt="Subcast" class="mb-3 h-20 w-20">
              <h2 class="text-xl font-semibold tracking-tight">Subcast</h2>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ t('desktop.about.subtitle') }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">v{{ appVersion }}</p>

              <hr class="my-4 w-full border-border/60">

              <p class="text-sm text-success">
                {{ t('desktop.about.fullyLocal') }}
              </p>

              <hr class="my-4 w-full border-border/60">

              <div class="w-full">
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground text-left">
                  {{ t('desktop.about.depsHeader') }}
                </h3>
                <ul class="space-y-1">
                  <li
                    v-for="d in aboutDependencies"
                    :key="d.name"
                    class="flex justify-between text-xs text-foreground"
                  >
                    <span>· {{ d.name }} <span class="text-muted-foreground">{{ d.version }}</span></span>
                    <span class="text-muted-foreground">{{ d.license }}</span>
                  </li>
                </ul>
              </div>

              <hr class="my-4 w-full border-border/60">

              <p class="text-xs text-muted-foreground">
                {{ t('desktop.about.licenseLine') }}
                <a
                  :href="LICENSE_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline decoration-border hover:text-foreground"
                >AGPL-3.0</a>
              </p>

              <div class="mt-4 flex flex-wrap justify-center gap-2">
                <a
                  :href="REPO_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >{{ t('desktop.about.buttons.repository') }}</a>
                <a
                  :href="LICENSE_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >{{ t('desktop.about.buttons.license') }}</a>
                <a
                  :href="ISSUES_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >{{ t('desktop.about.buttons.reportIssue') }}</a>
              </div>
            </section>
          </TabsContent>
        </div>
      </Tabs>
    </div>

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
          <Button variant="secondary" @click="pendingDelete = null">
            {{ t('settings.models.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmDelete">
            <Trash2 class="h-4 w-4" />
            {{ t('settings.models.confirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </AppShell>
</template>
