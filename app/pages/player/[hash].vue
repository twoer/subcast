<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- app/pages/player/[hash].vue -->
<script setup lang="ts">
import {
  Type, Keyboard, ChevronLeft, Check, X as XIcon, AlertCircle, AlertTriangle, Loader2,
  Play, Pause, Volume2, Volume1, VolumeX, Captions, CaptionsOff,
  Maximize, Minimize, RotateCcw, Palette, Download, Sparkles,
} from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import ExportDialog from '@/components/ExportDialog.vue';
import SearchBar from '@/components/SearchBar.vue';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import InsightsPanel from '@/components/InsightsPanel.vue';
import { useSubtitleStreams, type CueData } from '@/composables/useSubtitleStreams';
import { useSubtitleTrack } from '@/composables/useSubtitleTrack';
import { useCueSearch } from '@/composables/useCueSearch';
import { useLangSwitcher } from '@/composables/useLangSwitcher';
import { usePlayerKeybindings } from '@/composables/usePlayerKeybindings';
import { useSubtitleStyle, COLOR_PRESETS } from '@/composables/useSubtitleStyle';
import { useVideoControls, SPEEDS } from '@/composables/useVideoControls';

const { t } = useI18n();

type ListItem =
  | { kind: 'cue'; key: string; cue: CueData; idx: number }
  | { kind: 'silence'; key: string; afterIdx: number; durationS: number };

const SILENCE_THRESHOLD_MS = 10_000;

const SUPPORTED_LANGS: Array<{ code: string; label: string }> = [
  { code: 'original', label: '' },
  { code: 'zh-CN', label: '中文（简体）' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en-US', label: 'English' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'es-ES', label: 'Español' },
];

function langLabel(code: string, fallbackLabel: string): string {
  return code === 'original' ? t('player.original') : fallbackLabel;
}

const SHORTCUTS: Array<{ keys: string; descKey: string }> = [
  { keys: 'Space / K', descKey: 'playPause' },
  { keys: '← / →', descKey: 'seek5' },
  { keys: 'J / L', descKey: 'seek10' },
  { keys: '↑ / ↓', descKey: 'volume' },
  { keys: '< / >', descKey: 'speed' },
  { keys: 'M', descKey: 'mute' },
  { keys: 'F', descKey: 'fullscreen' },
  { keys: 'C', descKey: 'subs' },
  { keys: '1-9', descKey: 'jumpPct' },
  { keys: '?', descKey: 'help' },
  { keys: 'Esc', descKey: 'esc' },
];

function statusBadgeClass(s: string) {
  // Borderless: avoid the chip-with-border "button" look. Status pills
  // are pure tags — bg + text color only.
  switch (s) {
    case 'running':
    case 'translating':
      return 'border-transparent bg-primary/10 text-primary';
    case 'done':
      return 'border-transparent bg-success/10 text-success';
    case 'error':
      return 'border-transparent bg-destructive/10 text-destructive';
    case 'cache':
      return 'border-transparent bg-muted text-muted-foreground';
    case 'suspect':
      return 'border-transparent bg-warning/10 text-warning-foreground dark:text-warning';
    case 'idle':
    default:
      return 'border-transparent bg-muted text-muted-foreground';
  }
}

const route = useRoute();
const hash = computed(() => String(route.params.hash));

const videoRef = ref<HTMLVideoElement | null>(null);
const currentLang = ref<string>('original');
// Tier id ('3b' | '7b' | '14b') or undefined when no LLM is configured.
// Passed to InsightsPanel so it can label the footer with the model that
// generated existing insights vs. the one a fresh run would use.
const llmModel = ref<string>('—');

const {
  isPlaying,
  duration,
  currentTime,
  volume,
  muted,
  isFullscreen,
  controlsVisible,
  playbackRate,
  onLoadedMetadata,
  onPlayState,
  onVolumeEvent,
  onTimeUpdate,
  onSeek,
  setVolume,
  showControls,
  onContainerLeave,
  togglePlay,
  seekBy,
  jumpTo,
  jumpPercent,
  bumpVolume,
  toggleMute,
  toggleFullscreen,
  setPlaybackRate,
  bumpSpeed,
  fmtClock,
  loadPlaybackRate,
} = useVideoControls({ videoRef });

const {
  subsVisible,
  addCueToTrack,
  rebuildTrack,
  toggleSubs,
} = useSubtitleTrack({ videoRef });

const showExport = ref(false);
const searchBarRef = ref<InstanceType<typeof SearchBar> | null>(null);

const {
  cuesByLang,
  cues,
  langStatus,
  status,
  errMsg,
  fromCache,
  translateProgress,
  cachedLangs,
  isStreaming,
  openOriginalStream,
  openTranslateStream,
  closeStream,
  loadCachedLangs,
} = useSubtitleStreams({
  hash,
  currentLang,
  onCueForCurrentLang: addCueToTrack,
});

const {
  query: searchQuery,
  matchIdx: searchMatchIdx,
  matchSet: searchMatchSet,
  highlightSegments,
} = useCueSearch({ cues });

// Slice 7 player UX
const showHelp = ref(false);
const showSettings = ref(false);
const customColorInput = ref<HTMLInputElement | null>(null);

const showRetranscribeDialog = ref(false);
const retranscribing = ref(false);
const retranscribedLangCount = computed<number>(() => {
  // All language tracks beyond the original subtitle = translations the
  // retry would wipe. The dialog shows this count so users see the cost.
  return Object.keys(cuesByLang.value).filter((k) => k !== 'original').length;
});
async function confirmRetranscribe(): Promise<void> {
  retranscribing.value = true;
  try {
    await $fetch('/api/transcribe/retry', {
      method: 'POST',
      body: { hash: hash.value },
    });
    // Hard reload — the simplest way to flush every cached cue / stream
    // / insight state on the player page after a full reset.
    if (typeof window !== 'undefined') window.location.reload();
  } catch (e) {
    retranscribing.value = false;
    errMsg.value = e instanceof Error ? e.message : 'retranscribe failed';
  } finally {
    showRetranscribeDialog.value = false;
  }
}

const {
  style: subtitleStyle,
  isCustomColor,
  cueFontSize,
  cueColor,
  cueBg,
  load: loadSubtitleStyle,
  reset: resetSubtitleStyle,
} = useSubtitleStyle();

const { px: cueFontPx, load: loadCueFontSize } = useCueListFontSize();

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function seekToMs(ms: number) {
  const v = videoRef.value;
  if (!v) return;
  v.currentTime = ms / 1000;
  v.play().catch(() => {});
}

const activeIdx = computed(() => {
  const t = currentTime.value * 1000;
  const arr = cues.value;
  if (arr.length === 0) return -1;
  let lo = 0;
  let hi = arr.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.startMs <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  return t < arr[found]!.endMs ? found : -1;
});

const listItems = computed<ListItem[]>(() => {
  const out: ListItem[] = [];
  cues.value.forEach((c, idx) => {
    if (idx > 0) {
      const prev = cues.value[idx - 1]!;
      const gap = c.startMs - prev.endMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        out.push({ kind: 'silence', key: `s:${idx - 1}`, afterIdx: idx - 1, durationS: gap / 1000 });
      }
    }
    out.push({ kind: 'cue', key: `c:${idx}`, cue: c, idx });
  });
  return out;
});

const suspectCount = computed(
  () => cues.value.filter((c) => c.quality === 'suspect').length,
);

usePlayerKeybindings({
  focusSearch: () => searchBarRef.value?.focus(),
  showHelp,
  showSettings,
  togglePlay,
  seekBy,
  bumpVolume,
  bumpSpeed,
  toggleMute,
  toggleFullscreen,
  toggleSubs,
  jumpPercent,
});

const {
  showCancelDialog,
  cancelTranslation,
  retryCurrentLang,
  onLangChange,
} = useLangSwitcher({
  hash,
  currentLang,
  cuesByLang,
  langStatus,
  status,
  errMsg,
  fromCache,
  translateProgress,
  isStreaming,
  openOriginalStream,
  openTranslateStream,
  closeStream,
  rebuildTrack,
});

const videoName = ref<string>('');

onMounted(async () => {
  loadSubtitleStyle();
  loadCueFontSize();
  loadPlaybackRate();
  void loadCachedLangs();
  openOriginalStream();
  try {
    const s = await $fetch<{ settings?: { llmModel?: string } }>('/api/settings');
    if (s.settings?.llmModel) llmModel.value = s.settings.llmModel;
  } catch { /* ignore */ }
  // Resolve display name → originalName → hash-fallback for the header.
  // Reuses /api/cache/list (already cached by other panels) — cheap.
  try {
    const res = await $fetch<{
      items: Array<{ sha256: string; originalName: string; displayName: string | null }>;
    }>('/api/cache/list');
    const entry = res.items.find((i) => i.sha256 === hash.value);
    if (entry) videoName.value = entry.displayName ?? entry.originalName;
  } catch { /* keep empty — UI falls back to hash slice */ }
});

watch(activeIdx, (idx) => {
  if (idx < 0) return;
  const el = document.querySelector(`[data-cue-idx="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
</script>

<template>
  <!-- Player keeps its own flex shell (inner cue list owns its own
       scroll region) — can't share AppShell, which forces a top-level
       overflow-y-auto. AppHeader's `-mx-8` trick is gone, so the
       header sits directly under `<main>` (no parent padding) and the
       horizontal padding moves to the content wrapper below. -->
  <main class="flex h-dvh flex-col overflow-hidden bg-background">
    <AppHeader />

    <div class="flex min-h-0 flex-1 flex-col px-8 pt-4 pb-6">
      <div class="mx-auto flex min-h-0 w-full max-w-screen-2xl flex-1 flex-col px-4">
      <div class="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <Tooltip>
            <TooltipTrigger as-child>
              <NuxtLink
                to="/"
                :aria-label="t('app.back')"
                class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ChevronLeft class="h-6 w-6" />
              </NuxtLink>
            </TooltipTrigger>
            <TooltipContent>{{ t('app.back') }}</TooltipContent>
          </Tooltip>
          <!-- Visual divider so the back button and the video name read
               as two distinct things rather than one merged label. -->
          <span aria-hidden="true" class="h-5 w-px shrink-0 bg-border/60" />
          <span
            v-if="videoName"
            class="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            :title="videoName"
          >{{ videoName }}</span>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Select
            :model-value="currentLang"
            @update:model-value="(v: any) => onLangChange(v as string)"
          >
            <SelectTrigger class="h-8 w-[150px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="l in SUPPORTED_LANGS" :key="l.code" :value="l.code">
                <span class="flex items-center gap-2">
                  {{ langLabel(l.code, l.label) }}
                  <Check v-if="langStatus[l.code] === 'done'" class="h-3.5 w-3.5 text-success" />
                  <Loader2
                    v-else-if="langStatus[l.code] === 'running'"
                    class="h-3.5 w-3.5 animate-spin text-muted-foreground"
                  />
                  <XIcon
                    v-else-if="langStatus[l.code] === 'error'"
                    class="h-3.5 w-3.5 text-destructive"
                  />
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="outline"
                size="icon-sm"
                class="size-8 [&_svg]:size-3.5"
                :aria-label="t('player.export.title')"
                @click="showExport = true"
              >
                <Download />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('player.export.title') }}</TooltipContent>
          </Tooltip>

          <Select
            :model-value="String(playbackRate)"
            @update:model-value="(v: any) => setPlaybackRate(parseFloat(v as string))"
          >
            <SelectTrigger class="h-8 w-[72px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in SPEEDS" :key="s" :value="String(s)">{{ s }}x</SelectItem>
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="outline"
                size="icon-sm"
                class="size-8 [&_svg]:size-3.5"
                :aria-label="t('player.subtitleStyle')"
                @click="showSettings = true"
              >
                <Type />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('player.subtitleStyle') }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="outline"
                size="icon-sm"
                class="size-8 [&_svg]:size-3.5"
                :aria-label="t('player.shortcuts')"
                @click="showHelp = true"
              >
                <Keyboard />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('player.shortcuts') }} (?)</TooltipContent>
          </Tooltip>

          <Badge
            v-if="fromCache"
            variant="outline"
            size="sm"
            class="uppercase tracking-wider"
            :class="statusBadgeClass('cache')"
          >{{ t('player.cache') }}</Badge>
          <Badge
            variant="outline"
            size="sm"
            class="uppercase tracking-wider"
            :class="statusBadgeClass(status)"
          >{{ t(`player.status.${status}`) }}</Badge>
          <Badge
            v-if="translateProgress !== null && currentLang !== 'original'"
            variant="outline"
            size="sm"
            class="uppercase tracking-wider"
            :class="statusBadgeClass('translating')"
          >{{ t('player.translateProgress', { pct: translateProgress }) }}</Badge>
          <Tooltip v-if="translateProgress !== null && currentLang !== 'original'">
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3.5"
                :aria-label="t('player.cancelTranslation')"
                @click="showCancelDialog = true"
              >
                <XIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('player.cancelTranslation') }}</TooltipContent>
          </Tooltip>

          <!-- Re-transcribe lives at the far right of the action bar,
               separated by a divider, because it is destructive (clears
               original + all translations + insights). Three layers of
               protection against accidental clicks:
                 1. Spatial separation from innocuous controls (divider).
                 2. Icon + visible text label — the surrounding controls
                    are icon-only, so this button intentionally reads
                    heavier. Apple HIG / Material both recommend text
                    labels for destructive toolbar actions.
                 3. Confirmation dialog on click. -->
          <span
            v-if="cues.length > 0"
            aria-hidden="true"
            class="mx-1 h-5 w-px bg-border/60"
          />
          <Button
            v-if="cues.length > 0"
            variant="ghost"
            size="utility"
            class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            @click="showRetranscribeDialog = true"
          >
            <RotateCcw />
            {{ t('player.retranscribe.button') }}
          </Button>
        </div>
      </div>

      <div class="flex flex-col gap-6 min-h-0 flex-1 lg:flex-row">
        <div
          class="group relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black ring-1 ring-border/60 lg:min-h-0 lg:flex-1 lg:shrink"
          @mousemove="showControls"
          @mouseleave="onContainerLeave"
        >
          <video
            ref="videoRef"
            :src="`/api/video?hash=${hash}`"
            class="block w-full max-h-[60vh] cursor-pointer lg:max-h-full"
            crossorigin="anonymous"
            @timeupdate="onTimeUpdate"
            @loadedmetadata="onLoadedMetadata"
            @play="onPlayState"
            @pause="onPlayState"
            @volumechange="onVolumeEvent"
            @click="togglePlay"
          >
            <track default kind="subtitles" srclang="auto" :label="currentLang" >
          </video>

          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pt-14 pb-2 transition-opacity duration-200"
            :class="(controlsVisible || !isPlaying) ? 'opacity-100' : 'opacity-0'"
          >
            <input
              type="range"
              :min="0"
              :max="duration || 0"
              step="0.05"
              :value="currentTime"
              :aria-label="t('player.shortcutDescriptions.seek5')"
              class="pointer-events-auto h-1 w-full cursor-pointer appearance-none rounded-full bg-white/20 accent-primary"
              @input="onSeek"
            >

            <div class="pointer-events-auto mt-1.5 flex items-center gap-1 text-white">
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                    :aria-label="t('player.shortcutDescriptions.playPause')"
                    @click="togglePlay"
                  >
                    <Pause v-if="isPlaying" />
                    <Play v-else />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t('player.shortcutDescriptions.playPause') }}</TooltipContent>
              </Tooltip>

              <span class="ml-1 font-mono text-xs tabular-nums text-white/85">
                {{ fmtClock(currentTime) }} <span class="text-white/45">/</span> {{ fmtClock(duration) }}
              </span>

              <div class="ml-auto flex items-center gap-1">
                <div class="group/vol flex items-center">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                        :aria-label="t('player.shortcutDescriptions.mute')"
                        @click="toggleMute"
                      >
                        <VolumeX v-if="muted || volume === 0" />
                        <Volume1 v-else-if="volume < 0.5" />
                        <Volume2 v-else />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ t('player.shortcutDescriptions.mute') }}</TooltipContent>
                  </Tooltip>
                  <input
                    type="range"
                    min="0" max="1" step="0.05"
                    :value="muted ? 0 : volume"
                    :aria-label="t('player.shortcutDescriptions.volume')"
                    class="ml-1 hidden h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/20 accent-primary group-hover/vol:block"
                    @input="setVolume"
                  >
                </div>

                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                      :class="!subsVisible && 'opacity-50'"
                      :aria-label="t('player.shortcutDescriptions.subs')"
                      :aria-pressed="subsVisible"
                      @click="toggleSubs"
                    >
                      <Captions v-if="subsVisible" />
                      <CaptionsOff v-else />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ t('player.shortcutDescriptions.subs') }}</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                      :aria-label="t('player.shortcutDescriptions.fullscreen')"
                      @click="toggleFullscreen"
                    >
                      <Minimize v-if="isFullscreen" />
                      <Maximize v-else />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ t('player.shortcutDescriptions.fullscreen') }}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col lg:max-w-[28rem]">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('player.subtitles') }} · <span class="normal-case tracking-normal text-foreground">{{ langLabel(currentLang, SUPPORTED_LANGS.find((l) => l.code === currentLang)?.label ?? currentLang) }}</span>
            </h2>
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="font-mono tabular-nums">{{ t('player.cues', { n: cues.length }) }}</span>
              <Badge
                v-if="suspectCount > 0"
                variant="outline"
                size="sm"
                :class="statusBadgeClass('suspect')"
                :title="t('player.suspectTitle')"
              >{{ t('player.suspect', { n: suspectCount }) }}</Badge>
            </div>
          </div>
          <div
            v-if="errMsg"
            class="mb-3 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p class="flex-1 text-foreground/90">{{ errMsg }}</p>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 -my-1 -mr-1 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              @click="retryCurrentLang"
            >{{ t('player.errors.retry') }}</Button>
          </div>
          <Tabs default-value="subtitles" class="flex flex-1 flex-col min-h-0">
            <TabsList class="grid w-full grid-cols-2">
              <TabsTrigger value="subtitles">{{ t('player.subtitles') }}</TabsTrigger>
              <TabsTrigger value="insights">
                <Sparkles class="mr-1 h-3.5 w-3.5" />
                {{ t('player.insights.tabLabel') }}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="subtitles" class="flex flex-1 flex-col gap-2 min-h-0">
              <SearchBar
                ref="searchBarRef"
                :cues="cues"
                @update:query="searchQuery = $event"
                @update:match-idx="searchMatchIdx = $event"
              />
              <ul
                class="surface-1 flex-1 min-h-0 space-y-0.5 overflow-y-auto rounded-xl border border-border/50 bg-muted/30 p-2 font-mono leading-relaxed"
                :style="{ fontSize: `${cueFontPx}px` }"
              >
                <template v-for="item in listItems" :key="item.key">
                  <li
                    v-if="item.kind === 'silence'"
                    class="select-none py-1.5 text-center text-xs text-muted-foreground/70"
                  >{{ t('player.noAudio', { n: Math.round(item.durationS) }) }}</li>
                  <li
                    v-else
                    :data-cue-idx="item.idx"
                    role="button"
                    tabindex="0"
                    class="relative flex cursor-pointer items-baseline gap-3 rounded-md border border-transparent px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    :class="[
                      item.idx === activeIdx
                        ? 'bg-primary/10 font-medium text-foreground'
                        : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground',
                      item.cue.quality === 'suspect' && item.idx !== activeIdx ? 'border-warning/40' : '',
                      searchMatchSet.has(item.idx) ? 'bg-yellow-200/30 dark:bg-yellow-500/15' : '',
                      searchMatchIdx === item.idx ? 'ring-2 ring-yellow-500/60' : '',
                    ]"
                    :title="item.cue.quality === 'suspect' ? t('player.suspectCueTitle') : ''"
                    @click="jumpTo(item.cue.startMs)"
                    @keydown="(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); jumpTo(item.cue.startMs); } }"
                  >
                    <span
                      class="shrink-0 text-xs tabular-nums"
                      :class="item.idx === activeIdx ? 'font-semibold text-primary' : 'text-muted-foreground'"
                    >{{ fmtTime(item.cue.startMs) }}</span>
                    <span class="flex-1">
                      <template v-for="(seg, si) in highlightSegments(item.cue.text, searchQuery)" :key="si">
                        <mark v-if="seg.m" class="rounded-sm bg-yellow-300/70 px-0.5 text-inherit">{{ seg.t }}</mark>
                        <template v-else>{{ seg.t }}</template>
                      </template>
                    </span>
                    <AlertCircle
                      v-if="item.cue.quality === 'suspect'"
                      class="h-3.5 w-3.5 shrink-0 text-warning"
                    />
                  </li>
                </template>
                <li v-if="cues.length === 0 && status === 'running'" class="py-6 text-center text-muted-foreground">
                  <template v-if="currentLang === 'original'">{{ t('player.firstCueDelay') }}</template>
                  <template v-else>{{ t('player.translatingShort') }}</template>
                </li>
              </ul>
            </TabsContent>
            <TabsContent value="insights" class="flex flex-1 flex-col min-h-0">
              <InsightsPanel
                :hash="hash"
                :cue-count="cuesByLang['original']?.length ?? 0"
                :current-llm-model="llmModel"
                @seek="seekToMs"
              />
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>

    <ExportDialog
      v-model="showExport"
      :hash="hash"
      :cached-langs="cachedLangs"
      :lang-label="(code: string) => langLabel(code, SUPPORTED_LANGS.find(l => l.code === code)?.label ?? code)"
    />

    <Dialog v-model:open="showHelp">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Keyboard class="h-4 w-4 text-muted-foreground" />
            {{ t('player.shortcuts') }}
          </DialogTitle>
        </DialogHeader>
        <table class="w-full text-sm">
          <tbody>
            <tr
              v-for="s in SHORTCUTS"
              :key="s.keys"
              class="border-b border-border/50 last:border-0"
            >
              <td class="py-2 pr-4 font-mono text-primary-strong dark:text-primary">{{ s.keys }}</td>
              <td class="py-2 text-foreground/80">{{ t(`player.shortcutDescriptions.${s.descKey}`) }}</td>
            </tr>
          </tbody>
        </table>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showCancelDialog">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('player.cancelTranslationTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('player.cancelTranslationDesc') }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" @click="showCancelDialog = false">
            {{ t('player.cancel') }}
          </Button>
          <Button variant="destructive" @click="cancelTranslation">
            <XIcon class="h-4 w-4" />
            {{ t('player.cancelTranslationConfirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showRetranscribeDialog">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <RotateCcw class="h-4 w-4 text-muted-foreground" />
            {{ t('player.retranscribe.title') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('player.retranscribe.desc', { n: retranscribedLangCount }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" :disabled="retranscribing" @click="showRetranscribeDialog = false">
            {{ t('player.cancel') }}
          </Button>
          <Button variant="destructive" :disabled="retranscribing" @click="confirmRetranscribe">
            <RotateCcw class="h-4 w-4" />
            {{ t('player.retranscribe.confirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showSettings">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Type class="h-4 w-4 text-muted-foreground" />
            {{ t('player.subtitleStyle') }}
          </DialogTitle>
        </DialogHeader>
        <div class="space-y-6 text-sm">
          <div class="space-y-2">
            <Label class="flex items-center justify-between text-sm font-medium">
              <span>{{ t('player.fontSize') }}</span>
              <span class="font-mono text-xs text-muted-foreground">{{ subtitleStyle.fontSize.toFixed(2) }}em</span>
            </Label>
            <input
              v-model.number="subtitleStyle.fontSize"
              type="range"
              min="0.6"
              max="2.0"
              step="0.05"
              class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            >
          </div>
          <div class="space-y-2.5">
            <Label class="text-sm font-medium">{{ t('player.color') }}</Label>
            <div class="flex flex-wrap items-center gap-2">
              <Tooltip v-for="p in COLOR_PRESETS" :key="p.value">
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    :aria-label="p.label"
                    :aria-pressed="subtitleStyle.color.toLowerCase() === p.value.toLowerCase()"
                    class="relative grid size-7 place-items-center rounded-full border border-border/60 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    :style="{ backgroundColor: p.value }"
                    @click="subtitleStyle.color = p.value"
                  >
                    <Check
                      v-if="subtitleStyle.color.toLowerCase() === p.value.toLowerCase()"
                      class="h-3.5 w-3.5"
                      :style="{ color: p.value === '#ffffff' || p.value === '#facc15' ? '#000' : '#fff' }"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{{ p.label }}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    :aria-label="t('player.customColor')"
                    :aria-pressed="isCustomColor"
                    class="relative grid size-7 place-items-center rounded-full border border-border/60 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    :style="isCustomColor
                      ? { backgroundColor: subtitleStyle.color }
                      : { background: 'conic-gradient(from 90deg, #ef4444, #facc15, #4ade80, #22d3ee, #818cf8, #f472b6, #ef4444)' }"
                    @click="customColorInput?.click()"
                  >
                    <Palette
                      v-if="!isCustomColor"
                      class="h-3.5 w-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]"
                    />
                    <Check v-else class="h-3.5 w-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{{ t('player.customColor') }}</TooltipContent>
              </Tooltip>
              <input
                ref="customColorInput"
                v-model="subtitleStyle.color"
                type="color"
                class="sr-only"
                tabindex="-1"
                aria-hidden="true"
              >
              <span class="ml-1 font-mono text-xs uppercase text-muted-foreground">{{ subtitleStyle.color }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <Label class="flex items-center justify-between text-sm font-medium">
              <span>{{ t('player.bgOpacity') }}</span>
              <span class="font-mono text-xs text-muted-foreground">{{ Math.round(subtitleStyle.bgOpacity * 100) }}%</span>
            </Label>
            <input
              v-model.number="subtitleStyle.bgOpacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            >
          </div>
          <div class="flex justify-end border-t border-border/50 pt-4">
            <Button
              variant="ghost"
              size="sm"
              class="text-xs text-muted-foreground hover:text-foreground"
              @click="resetSubtitleStyle"
            >
              <RotateCcw class="h-3.5 w-3.5" />
              {{ t('player.reset') }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </div>
  </main>
</template>

<style>
/*
 * Slice 7 native subtitle styling. Vue 3 SFC v-bind() lets us push the
 * reactive style values into ::cue, which is the WebVTT pseudo-element the
 * browser uses to render text inside <track default kind="subtitles">.
 *
 * Browser support: Chrome / Edge / Safari all honor ::cue. Firefox is
 * partial (color works, background-color is sometimes capped). For Slice 7
 * this is enough; deeper customization can land later via a custom overlay.
 */
::cue {
  font-size: v-bind(cueFontSize);
  color: v-bind(cueColor);
  background-color: v-bind(cueBg);
}
</style>
