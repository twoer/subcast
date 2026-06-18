<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import {
  Settings as SettingsIcon,
  Languages,
  HelpCircle,
  Home,
  Library,
  Boxes,
  ChevronDown,
  ArrowRight,
  Check,
} from 'lucide-vue-next';
import { onClickOutside } from '@vueuse/core';
import { Button } from '~/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';

withDefaults(
  defineProps<{
    lanUrl?: string | null;
    /**
     * Hide the Home / Library primary nav buttons. Setup wizard uses this
     * to keep users on-flow — the wizard is a guided first-run experience
     * and stray primary-nav clicks could abandon setup half-done.
     */
    showPrimaryNav?: boolean;
  }>(),
  { lanUrl: null, showPrimaryNav: true },
);

const { locale, setLocale, t } = useI18n();
const desktop = useDesktop();
const { count: libraryCount, refresh: refreshLibraryCount } = useLibraryCount();
const { data: activeModels, refresh: refreshActiveModels } = useActiveModels();
const { items: queueItems } = useQueueList();

// "Any task currently running" — the chip-sweep overlay only renders
// while this is true, so the animation isn't burning compositing
// budget when there's no work in flight. `queued` doesn't count
// because the model isn't held yet.
const isAnyTaskBusy = computed(() => queueItems.value.some((it) => it.status === 'running'));

onMounted(() => {
  void refreshLibraryCount();
  void refreshActiveModels();
});

const modelsOpen = ref(false);
const modelsRoot = ref<HTMLDivElement | null>(null);
onClickOutside(modelsRoot, () => {
  modelsOpen.value = false;
});

function onModelsKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') modelsOpen.value = false;
}

// Three-way readiness → visible badge state.
// `null` (unknown — web mode or pre-refresh) renders as no dot so the
// chip doesn't flash a warning before the first /api/desktop/models
// response settles.
function whisperWarn(): string | null {
  const m = activeModels.value;
  if (!m || m.whisperReady !== false) return null;
  return t('app.modelNotInstalled', { name: m.whisperModel });
}

function llmWarn(): string | null {
  const m = activeModels.value;
  if (!m) return null;
  // llama-server is an in-process binary spawned by Subcast itself —
  // there is no "runtime not started" state to surface. Either the
  // active tier id matches an installed GGUF or it doesn't.
  if (m.llmReady === false) return t('app.llmNotInstalled');
  return null;
}

const chipWarn = computed(() => whisperWarn() ?? llmWarn());
const whisperWarnMsg = computed(() => whisperWarn());
const llmWarnMsg = computed(() => llmWarn());

// In desktop mode, the dedicated Models tab is visible. In web mode it's
// filtered out by `settings.vue`, so deep-link `#preferences` instead so
// the link still lands somewhere useful.
const manageModelsHref = computed(() =>
  desktop.isDesktop ? '/settings#models' : '/settings#preferences',
);

// Locale menu items. `label` is shown in the popover (native script for
// each language, so users in the wrong locale can still identify their
// own); `short` is the compact glyph on the trigger button.
const LOCALE_OPTIONS = [
  { code: 'en',    label: 'English',      short: 'EN' },
  { code: 'zh',    label: '简体中文',     short: '简' },
  { code: 'zh-TW', label: '繁體中文',     short: '繁' },
  { code: 'ja',    label: '日本語',       short: 'あ' },
  { code: 'es',    label: 'Español',      short: 'ES' },
] as const;
type LocaleCode = typeof LOCALE_OPTIONS[number]['code'];

const localeOpen = ref(false);
const localeRoot = ref<HTMLDivElement | null>(null);
onClickOutside(localeRoot, () => {
  localeOpen.value = false;
});

function onLocaleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') localeOpen.value = false;
}

const currentLocaleOption = computed(
  () => LOCALE_OPTIONS.find((o) => o.code === locale.value) ?? LOCALE_OPTIONS[0],
);
const localeLabel = computed(() => currentLocaleOption.value.short);

function chooseLocale(code: LocaleCode): void {
  if (code !== locale.value) setLocale(code);
  localeOpen.value = false;
}

// Primary nav buttons share this base style; active highlight is layered
// on via NuxtLink's exact-active-class. Sized larger and with more
// weight than the right-side utility group so the hierarchy is clear
// (primary nav > Models chip > Lang/Settings/Help icons).
const NAV_BTN_CLASS =
  'relative flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const NAV_BTN_ACTIVE = 'bg-accent text-foreground font-semibold';
</script>

<template>
  <!-- Header sits in row 1 of AppShell's grid (h-dvh) and is no longer
       sticky / negatively-margined — the scrollbar lives inside row 2,
       below the header, so we don't need to overlay scrolling content. -->
  <header
    class="border-b border-border/60 bg-background px-8 py-3"
  >
    <!-- min-h-9 pins the row to the taller primary-nav button height
         (h-9). Without it, pages that hide the nav (e.g. setup wizard)
         collapse to the h-8 utility row, making the header visually 4 px
         shorter than pages with the nav. -->
    <div class="mx-auto flex min-h-9 w-full items-center justify-between gap-4">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="group flex items-center gap-2.5 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md"
        >
          <span class="grid h-8 w-8 place-items-center overflow-hidden rounded-lg shadow-sm ring-1 ring-inset ring-white/10">
            <svg
              viewBox="0 0 32 32"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              class="h-full w-full"
            >
              <rect width="32" height="32" fill="url(#subcastLogoGrad)" />
              <rect x="7" y="9" width="18" height="2.5" rx="1.25" fill="#fff" fill-opacity="0.95" />
              <rect x="7" y="14.75" width="14" height="2.5" rx="1.25" fill="#fff" fill-opacity="0.75" />
              <rect x="7" y="20.5" width="10" height="2.5" rx="1.25" fill="#fff" fill-opacity="0.55" />
              <defs>
                <linearGradient id="subcastLogoGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="hsl(var(--primary))" />
                  <stop offset="1" stop-color="hsl(var(--primary-strong))" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <span class="text-[15px] font-semibold tracking-tight">Subcast</span>
        </NuxtLink>

        <nav v-if="showPrimaryNav" class="ml-2 flex items-center gap-1">
          <!-- Sized divider that matches the button's visual text height
               (~20px), not the full button hit-area height (36px). A plain
               `border-l` on the nav was rendering taller than the button
               glyphs and looked like a stray vertical bar. -->
          <span aria-hidden="true" class="mr-2 h-5 w-px bg-border/60" />
          <NuxtLink
            to="/"
            :class="NAV_BTN_CLASS"
            :exact-active-class="NAV_BTN_ACTIVE"
          >
            <Home class="h-4 w-4" />
            <span>{{ t('app.home') }}</span>
          </NuxtLink>
          <NuxtLink
            to="/library"
            :class="NAV_BTN_CLASS"
            :exact-active-class="NAV_BTN_ACTIVE"
          >
            <Library class="h-4 w-4" />
            <span>{{ t('app.library') }}</span>
            <span
              v-if="libraryCount !== null"
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 font-mono text-3xs font-semibold tabular-nums text-primary"
            >{{ libraryCount }}</span>
          </NuxtLink>
        </nav>
      </div>

      <div class="flex items-center gap-2 text-xs">
        <span
          v-if="lanUrl && !desktop.isDesktop"
          class="hidden h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 font-mono text-muted-foreground sm:flex"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-success" />
          {{ lanUrl }}
        </span>

        <div ref="modelsRoot" class="relative hidden md:block" @keydown="onModelsKeydown">
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                :aria-label="$t('app.models')"
                :aria-expanded="modelsOpen"
                aria-haspopup="dialog"
                class="group relative isolate flex h-8 max-w-[20rem] items-center gap-2 overflow-hidden rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                :class="modelsOpen ? 'bg-accent text-foreground shadow-sm' : ''"
                @click="modelsOpen = !modelsOpen"
              >
                <!-- Sweep overlay: a 1/3-width primary-tinted band travelling
                     left→right while any task is running. `isolate` on the
                     button creates a stacking context so `-z-10` keeps the
                     band behind the icon/text without bleeding behind the
                     header itself. Hidden under reduced-motion. -->
                <span
                  v-if="isAnyTaskBusy"
                  aria-hidden="true"
                  class="pointer-events-none absolute inset-0 -z-10 motion-reduce:hidden"
                >
                  <span
                    class="block h-full w-1/3 -translate-x-full bg-gradient-to-r from-transparent via-primary/30 to-transparent animate-chip-sweep"
                  />
                </span>
                <!-- Icon doubles as the live indicator: tinted to primary
                     when a task is running so the busy state isn't conveyed
                     by the sweep band alone (color-not-decorative-only). -->
                <Boxes
                  class="h-3.5 w-3.5 shrink-0 transition-colors"
                  :class="isAnyTaskBusy ? 'text-primary' : 'opacity-70'"
                />
                <span class="flex items-center gap-1 truncate font-mono text-2xs tabular-nums">
                  <span class="truncate">{{ activeModels?.whisperModel ?? '—' }}</span>
                  <span
                    v-if="whisperWarnMsg"
                    aria-hidden="true"
                    class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                </span>
                <!-- Slim vertical rule replaces the middle-dot — reads as
                     structural separator, not punctuation. -->
                <span aria-hidden="true" class="h-3 w-px shrink-0 bg-border" />
                <span class="flex items-center gap-1 truncate font-mono text-2xs tabular-nums">
                  <span class="truncate">{{ activeModels?.llmModel ?? '—' }}</span>
                  <span
                    v-if="llmWarnMsg"
                    aria-hidden="true"
                    class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                </span>
                <ChevronDown
                  class="h-3 w-3 shrink-0 opacity-60 transition-transform duration-150"
                  :class="modelsOpen ? 'rotate-180' : ''"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {{ chipWarn ?? (isAnyTaskBusy ? $t('app.modelBusy') : $t('app.modelsActive')) }}
            </TooltipContent>
          </Tooltip>
          <Transition
            enter-active-class="transition duration-150 ease-out"
            enter-from-class="opacity-0 -translate-y-1"
            enter-to-class="opacity-100 translate-y-0"
            leave-active-class="transition duration-100 ease-in"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="modelsOpen"
              role="dialog"
              :aria-label="$t('app.modelsActive')"
              class="surface-1 absolute right-0 top-full z-40 mt-1.5 w-64 rounded-lg border border-border/60 bg-popover p-3 shadow-lg ring-1 ring-black/[0.04]"
            >
              <div class="space-y-3">
                <div>
                  <div class="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Whisper
                  </div>
                  <div class="mt-0.5 flex items-center gap-1.5 truncate font-mono text-sm font-medium text-foreground">
                    <span class="truncate">{{ activeModels?.whisperModel ?? '—' }}</span>
                    <span
                      v-if="whisperWarnMsg"
                      aria-hidden="true"
                      class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    />
                  </div>
                  <div
                    v-if="whisperWarnMsg"
                    class="mt-0.5 text-2xs font-medium text-amber-600"
                  >
                    {{ whisperWarnMsg }}
                  </div>
                </div>
                <div>
                  <div class="text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {{ $t('app.llmLabel') }}
                  </div>
                  <div class="mt-0.5 flex items-center gap-1.5 truncate font-mono text-sm font-medium text-foreground">
                    <span class="truncate">{{ activeModels?.llmModel ?? '—' }}</span>
                    <span
                      v-if="llmWarnMsg"
                      aria-hidden="true"
                      class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    />
                  </div>
                  <div
                    v-if="llmWarnMsg"
                    class="mt-0.5 text-2xs font-medium text-amber-600"
                  >
                    {{ llmWarnMsg }}
                  </div>
                </div>
              </div>
              <div class="mt-3 border-t border-border/60" />
              <NuxtLink
                :to="manageModelsHref"
                class="mt-2 flex h-8 items-center justify-between gap-2 rounded-md px-2 text-xs font-medium text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                @click="modelsOpen = false"
              >
                <span>{{ $t('app.manageModels') }}</span>
                <ArrowRight class="h-3.5 w-3.5" />
              </NuxtLink>
            </div>
          </Transition>
        </div>

        <div ref="localeRoot" class="relative" @keydown="onLocaleKeydown">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="utility"
                class="text-muted-foreground hover:text-foreground"
                :aria-label="$t('app.language')"
                :aria-expanded="localeOpen"
                aria-haspopup="menu"
                @click="localeOpen = !localeOpen"
              >
                <Languages class="opacity-70" />
                <!-- Fixed width + center so the trigger's footprint
                     doesn't change between EN / 简 / 繁 / あ / ES.
                     Without this, the right-side flex group grows by
                     a few px on switch and pushes the Models chip
                     left-of-it (it's `justify-between` from the page
                     edge). w-4 fits all five glyphs comfortably. -->
                <span class="inline-block w-4 text-center font-semibold">{{ localeLabel }}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ $t('app.language') }}</TooltipContent>
          </Tooltip>
          <Transition
            enter-active-class="transition duration-150 ease-out"
            enter-from-class="opacity-0 -translate-y-1"
            enter-to-class="opacity-100 translate-y-0"
            leave-active-class="transition duration-100 ease-in"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 -translate-y-1"
          >
            <div
              v-if="localeOpen"
              role="menu"
              :aria-label="$t('app.language')"
              class="surface-1 absolute right-0 top-full z-40 mt-1.5 w-40 rounded-lg border border-border/60 bg-popover p-1 shadow-lg ring-1 ring-black/[0.04]"
            >
              <button
                v-for="opt in LOCALE_OPTIONS"
                :key="opt.code"
                type="button"
                role="menuitemradio"
                :aria-checked="opt.code === locale"
                class="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
                @click="chooseLocale(opt.code)"
              >
                <span>{{ opt.label }}</span>
                <Check
                  v-if="opt.code === locale"
                  class="h-3.5 w-3.5 text-primary"
                  aria-hidden="true"
                />
              </button>
            </div>
          </Transition>
        </div>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button as-child variant="ghost" size="utility" class="text-muted-foreground hover:text-foreground">
              <NuxtLink to="/settings" :aria-label="$t('app.settings')">
                <SettingsIcon />
              </NuxtLink>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ $t('app.settings') }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button as-child variant="ghost" size="utility" class="text-muted-foreground hover:text-foreground">
              <NuxtLink to="/help" :aria-label="$t('desktop.help.title')">
                <HelpCircle />
              </NuxtLink>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ $t('desktop.help.title') }}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </header>
</template>
