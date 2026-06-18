<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * Help page shell. Holds the tab list + hash-driven routing only; each
 * tab's content (and any data it needs) lives in `./components/*Tab.vue`.
 */
import { CalendarClock, HelpCircle, Info } from 'lucide-vue-next';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import Help from './components/Help.vue';
import About from './components/About.vue';
import Changelog from './components/Changelog.vue';

type TabId = 'help' | 'about' | 'changelog';

const { t } = useI18n();
const route = useRoute();

const TABS: Array<{ id: TabId; labelKey: string; icon: typeof HelpCircle }> = [
  { id: 'help', labelKey: 'help.tabs.help', icon: HelpCircle },
  { id: 'about', labelKey: 'help.tabs.about', icon: Info },
  { id: 'changelog', labelKey: 'help.tabs.changelog', icon: CalendarClock },
];

const currentTab = ref<TabId>('help');

function isVisibleTab(value: string): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

function syncFromHash(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash.slice(1);
  if (isVisibleTab(hash)) currentTab.value = hash;
}

function onTabChange(value: string | number): void {
  const tab = String(value);
  if (!isVisibleTab(tab)) return;
  currentTab.value = tab;
  if (typeof window !== 'undefined' && window.location.hash !== `#${tab}`) {
    window.history.replaceState(null, '', `#${tab}`);
  }
}

// In-app hash navigation (e.g. menu → /help#about) uses vue-router push,
// which goes through history.pushState — pushState does NOT fire
// `hashchange`. This watcher catches programmatic same-route navigation;
// the native `hashchange` listener below still covers deep-link reloads
// and manual URL edits.
watch(() => route.hash, syncFromHash);

onMounted(() => {
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
        <h1 class="text-2xl font-semibold tracking-tight">{{ t('help.title') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('help.subtitle') }}</p>
      </header>

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
          <TabsContent value="help" class="mt-0 focus-visible:outline-none">
            <Help />
          </TabsContent>

          <TabsContent value="about" class="mt-0 focus-visible:outline-none">
            <About />
          </TabsContent>

          <TabsContent value="changelog" class="mt-0 focus-visible:outline-none">
            <Changelog />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  </AppShell>
</template>
