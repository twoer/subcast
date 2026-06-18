<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import {
  Cpu, Sliders, Boxes,
  LayoutDashboard,
} from 'lucide-vue-next';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import Models from './components/Models.vue';
import type { Settings, Hardware } from '@/types/settings';

interface Resp {
  settings: Settings;
  hardware: Hardware;
}

const { t } = useI18n();
const desktop = useDesktop();
const { set: setActiveModelsCache, refresh: refreshActiveModels } = useActiveModels();

const settings = ref<Settings | null>(null);
const hardware = ref<Hardware | null>(null);
const draft = ref<Settings | null>(null);
const saving = ref(false);
const savedAt = ref<number | null>(null);
const errMsg = ref<string | null>(null);

const { px: cueFontPx, load: loadCueFontSize, save: saveCueFontSize, MIN_PX: CUE_MIN, MAX_PX: CUE_MAX } = useCueListFontSize();

// All tab ids, plus a computed visible list that hides desktop-only tabs
// in the web build. `models` is the only desktop-gated tab today.
type TabId = 'overview' | 'preferences' | 'models';

const TABS = computed<Array<{ id: TabId; labelKey: string; icon: typeof Cpu }>>(() => {
  const all: Array<{ id: TabId; labelKey: string; icon: typeof Cpu }> = [
    { id: 'overview',    labelKey: 'settings.tabs.overview',    icon: LayoutDashboard },
    { id: 'preferences', labelKey: 'settings.tabs.preferences', icon: Sliders },
    { id: 'models',      labelKey: 'settings.tabs.models',      icon: Boxes },
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
    chunkingStrategy: draft.value.chunkingStrategy,
  });
}

function applyRecommended() {
  if (!draft.value || !hardware.value) return;
  draft.value.whisperModel = hardware.value.recommended.whisperModel as Settings['whisperModel'];
  draft.value.llmModel = hardware.value.recommended.llmModel;
}

const dirtyPrefs = computed(() => {
  if (!settings.value || !draft.value) return false;
  return (
    draft.value.cacheLimitGB !== settings.value.cacheLimitGB
    || draft.value.silenceThresholdMs !== settings.value.silenceThresholdMs
    || draft.value.debugMode !== settings.value.debugMode
    || draft.value.chunkingStrategy !== settings.value.chunkingStrategy
  );
});

// In-app hash navigation (e.g. menu → /settings#models) uses vue-router
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
});
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', syncFromHash);
});
</script>

<template>
  <AppShell>
    <template #header>
      <AppHeader />
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
                <Label class="text-sm font-medium">{{ t('settings.chunkingStrategy.title') }}</Label>
                <p class="text-xs text-muted-foreground">{{ t('settings.chunkingStrategy.hint') }}</p>
                <div class="space-y-2 pt-1">
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3 transition-colors hover:bg-muted/50"
                  >
                    <input
                      v-model="draft.chunkingStrategy"
                      type="radio"
                      value="vad"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
                    >
                    <span class="flex-1 space-y-0.5">
                      <span class="block text-sm font-medium">{{ t('settings.chunkingStrategy.vad') }}</span>
                      <span class="block text-xs text-muted-foreground">{{ t('settings.chunkingStrategy.vadHint') }}</span>
                    </span>
                  </label>
                  <label
                    class="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3 transition-colors hover:bg-muted/50"
                  >
                    <input
                      v-model="draft.chunkingStrategy"
                      type="radio"
                      value="fixed-time"
                      class="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
                    >
                    <span class="flex-1 space-y-0.5">
                      <span class="block text-sm font-medium">{{ t('settings.chunkingStrategy.fixed') }}</span>
                      <span class="block text-xs text-muted-foreground">{{ t('settings.chunkingStrategy.fixedHint') }}</span>
                    </span>
                  </label>
                </div>
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

          <TabsContent v-if="desktop.isDesktop" value="models" class="mt-0 focus-visible:outline-none">
            <Models
              v-model:draft="draft"
              v-model:settings="settings"
              :hardware="hardware"
              :saving="saving"
              :saved-at="savedAt"
              @save="saveActiveModels"
            />
          </TabsContent>

        </div>
      </Tabs>
    </div>
  </AppShell>
</template>
