<script setup lang="ts">
import { Settings as SettingsIcon, Languages } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    lanUrl?: string | null;
    showSettingsLink?: boolean;
  }>(),
  { showSettingsLink: true },
);

const { locale, setLocale, t } = useI18n();

function toggleLocale() {
  setLocale(locale.value === 'zh' ? 'en' : 'zh');
}

const localeLabel = computed(() => (locale.value === 'zh' ? '中' : 'EN'));
const nextLocaleLabel = computed(() => (locale.value === 'zh' ? 'English' : '中文'));
const switchHint = computed(() => t('app.switchTo', { lang: nextLocaleLabel.value }));
</script>

<template>
  <header
    class="sticky top-0 z-30 -mx-8 mb-6 border-b border-border/60 bg-background/85 px-8 py-3 backdrop-blur-md"
  >
    <div class="mx-auto flex max-w-screen-2xl items-center justify-between gap-4">
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

      <div class="flex items-center gap-2 text-xs">
        <span
          v-if="lanUrl"
          class="hidden h-8 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 font-mono text-muted-foreground sm:flex"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-success" />
          {{ lanUrl }}
        </span>
        <button
          type="button"
          :title="switchHint"
          :aria-label="switchHint"
          class="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          @click="toggleLocale"
        >
          <Languages class="h-3.5 w-3.5 opacity-70" />
          <span class="font-mono tabular-nums">{{ localeLabel }}</span>
        </button>
        <NuxtLink
          v-if="showSettingsLink"
          to="/settings"
          class="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <SettingsIcon class="h-3.5 w-3.5" />
          {{ $t('app.settings') }}
        </NuxtLink>
      </div>
    </div>
  </header>
</template>
