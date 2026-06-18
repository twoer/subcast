<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- app/pages/player/[hash].vue -->
<script setup lang="ts">
import {
  AlertCircle, Info,
  Play, Pause, Volume2, Volume1, VolumeX, Captions, CaptionsOff,
  Maximize, Minimize, Sparkles,
} from 'lucide-vue-next';
import ExportDialog from '@/components/ExportDialog.vue';
import PlayerDialogs from '@/components/PlayerDialogs.vue';
import PlayerToolbar from '@/components/PlayerToolbar.vue';
import SearchBar from '@/components/SearchBar.vue';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import InsightsPanel from '@/components/InsightsPanel.vue';
import WaveformBar from '@/components/WaveformBar.vue';
import { useSubtitleStreams, type CueData } from '@/composables/useSubtitleStreams';
import { useSubtitleTrack } from '@/composables/useSubtitleTrack';
import { useCueSearch } from '@/composables/useCueSearch';
import { useLangSwitcher } from '@/composables/useLangSwitcher';
import { usePlayerKeybindings } from '@/composables/usePlayerKeybindings';
import { useSubtitleStyle, COLOR_PRESETS } from '@/composables/useSubtitleStyle';
import { useVideoControls, SPEEDS } from '@/composables/useVideoControls';
import { useDiarizeStatus } from '@/composables/useDiarizeStatus';
import { useSubtitleView } from '@/composables/useSubtitleView';
import { useWaveformLoader } from '@/composables/useWaveformLoader';
import { useRetranscribeAction } from '@/composables/useRetranscribeAction';
import { usePlayerDiarizeActions } from '@/composables/usePlayerDiarizeActions';
import ViewToggle from '@/components/SubtitlePanel/ViewToggle.vue';
import UnknownWarningRibbon from '@/components/SubtitlePanel/UnknownWarningRibbon.vue';
import SpeakerChip from '@/components/SubtitlePanel/SpeakerChip.vue';
import SpeakerHeader from '@/components/SubtitlePanel/SpeakerHeader.vue';
import {
  speakerColorIndex,
  type SpeakerId,
} from '#shared/diarization';

const { t } = useI18n();

type ListItem =
  | { kind: 'cue'; key: string; cue: CueData; idx: number; speakerId: SpeakerId | null; firstOfRun: boolean }
  | { kind: 'silence'; key: string; afterIdx: number; durationS: number }
  | {
      kind: 'speakerHeader';
      key: string;
      speakerId: SpeakerId;
      durationS: number;
      ratio: number;
    };

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

const route = useRoute();
const hash = computed(() => String(route.params.hash));

const videoRef = ref<HTMLVideoElement | null>(null);
const currentLang = ref<string>('original');
// Tier id ('3b' | '7b' | '14b') or undefined when no LLM is configured.
// Passed to InsightsPanel so it can label the footer with the model that
// generated existing insights vs. the one a fresh run would use.
const llmModel = ref<string>('—');

const {
  peaks: waveformPeaks,
  load: loadWaveform,
  seek: onWaveformSeek,
} = useWaveformLoader(hash, videoRef);

onMounted(() => {
  void loadWaveform();
});

const desktop = useDesktop();
let unsubscribePauseMedia: (() => void) | null = null;
onMounted(() => {
  unsubscribePauseMedia = desktop.onPauseMedia(() => {
    videoRef.value?.pause();
  });
});
onBeforeUnmount(() => {
  unsubscribePauseMedia?.();
  unsubscribePauseMedia = null;
});

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
  translateRetryNotice,
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
  highlightSegments,
} = useCueSearch({ cues });

// Slice 7 player UX
const showHelp = ref(false);
const showSettings = ref(false);

const retranscribedLangCount = computed<number>(() => {
  // All language tracks beyond the original subtitle = translations the
  // retry would wipe. The dialog shows this count so users see the cost.
  return Object.keys(cuesByLang.value).filter((k) => k !== 'original').length;
});
const {
  showDialog: showRetranscribeDialog,
  running: retranscribing,
  confirm: confirmRetranscribe,
} = useRetranscribeAction(hash, {
  onError: (message) => {
    errMsg.value = message;
  },
});

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

// Diarization state + view preference (docs/diarization-plan.md v1.5).
const diarize = useDiarizeStatus(hash);
const subtitleView = useSubtitleView(diarize.summary);
const isDiarizing = computed(() =>
  diarize.status.value && diarize.status.value.status === 'running',
);
const isDiarizeDone = computed(() =>
  diarize.status.value && diarize.status.value.status === 'done',
);
const isOriginalTranscribeDone = computed(() => langStatus.value.original === 'done');
const canRunDiarize = computed(() =>
  cues.value.length > 0 &&
  isOriginalTranscribeDone.value &&
  diarize.status.value &&
  (diarize.status.value.status === 'none' || diarize.status.value.status === 'failed') &&
  !isDiarizing.value,
);
const diarizeActionFailed = computed(() =>
  canRunDiarize.value &&
  diarize.status.value !== null &&
  diarize.status.value.status === 'failed',
);
/** True when the player can show the toggle / speaker chips / headers. */
const showDiarizeUI = computed(() =>
  isDiarizeDone.value &&
  diarize.status.value !== null &&
  diarize.status.value.status === 'done' &&
  (diarize.status.value.finalSpeakerCount ?? 0) >= 2,
);

/** Per-cue speaker id lookup. Uses a simple "first overlap wins"
 * heuristic — v1.5 Q3 split rendering is a future enhancement; v1
 * just shows the dominant speaker chip without splitting cues. */
function speakerForCue(cue: CueData): SpeakerId | null {
  const s = diarize.status.value;
  if (!s || s.status !== 'done') return null;
  const timeline = s.timeline;
  let bestSpeaker: SpeakerId | null = null;
  let bestOverlap = 0;
  for (const seg of timeline) {
    const overlap = Math.max(0, Math.min(cue.endMs, seg.endMs) - Math.max(cue.startMs, seg.startMs));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = seg.speakerId;
    }
  }
  return bestSpeaker;
}

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
  const grouped = subtitleView.view.value === 'grouped' && showDiarizeUI.value;
  let lastSpeaker: SpeakerId | null = null;
  // Separate tracker for the list-view "speaker run" indicator. Reset on
  // silence so a 10s+ gap visually re-introduces the speaker chip.
  let lastListSpeaker: SpeakerId | null = null;

  // Per-speaker stats for the grouped-view block headers. Cheap enough
  // to recompute (cues array is bounded by chunks * cues/chunk; usually
  // a few hundred entries for an hour of video).
  const speakerStats = new Map<SpeakerId, { durationMs: number }>();
  if (grouped) {
    for (const c of cues.value) {
      const sp = speakerForCue(c);
      if (!sp) continue;
      const s = speakerStats.get(sp) ?? { durationMs: 0 };
      s.durationMs += c.endMs - c.startMs;
      speakerStats.set(sp, s);
    }
  }
  const totalSpeechMs = [...speakerStats.values()].reduce((sum, s) => sum + s.durationMs, 0);

  cues.value.forEach((c, idx) => {
    if (idx > 0) {
      const prev = cues.value[idx - 1]!;
      const gap = c.startMs - prev.endMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        out.push({ kind: 'silence', key: `s:${idx - 1}`, afterIdx: idx - 1, durationS: gap / 1000 });
        lastListSpeaker = null;
      }
    }
    const speakerId = grouped || subtitleView.view.value === 'list' ? speakerForCue(c) : null;

    if (grouped && speakerId && speakerId !== lastSpeaker) {
      const stat = speakerStats.get(speakerId);
      const durMs = stat?.durationMs ?? 0;
      out.push({
        kind: 'speakerHeader',
        key: `h:${idx}:${speakerId}`,
        speakerId,
        durationS: durMs / 1000,
        ratio: totalSpeechMs > 0 ? durMs / totalSpeechMs : 0,
      });
      lastSpeaker = speakerId;
    }

    const firstOfRun = speakerId !== null && speakerId !== lastListSpeaker;
    out.push({ kind: 'cue', key: `c:${idx}`, cue: c, idx, speakerId, firstOfRun });
    if (speakerId !== null) lastListSpeaker = speakerId;
  });
  return out;
});

/**
 * Thread color for the list-view speaker-run indicator. Matches the
 * SpeakerChip's hue ring (golden-angle * colorIndex) so the chip on the
 * first row of a run reads as the "head" of the colored thread on its
 * left. Lower opacity than the chip background so it sits behind text.
 */
function speakerThreadColor(sp: SpeakerId): string {
  if (sp === 'unknown') return 'hsl(215 16% 60% / 0.35)';
  const idx = speakerColorIndex(sp, diarize.appearanceOrder.value);
  const hue = (idx * 137) % 360;
  return `hsl(${hue} 75% 55% / 0.5)`;
}

const {
  renameSpeaker: handleRenameSpeaker,
  changeTopK: handleChangeTopK,
  run: handleRunDiarize,
} = usePlayerDiarizeActions(diarize, {
  onError: (message) => {
    errMsg.value = message;
  },
});

const suspectCount = computed(
  () => cues.value.filter((c) => c.quality === 'suspect').length,
);

// Meta-row helpers (toolbar cleanup, v2-inspired). The status chips
// used to sit next to action buttons and read as "current state =
// button" — testers reported it caused confusion on first use. The
// new title block surfaces these as muted text under the video name
// so they read as info, not actions.
const speakerCount = computed(() => {
  const s = diarize.status.value;
  if (!s || s.status !== 'done') return 0;
  return s.finalSpeakerCount ?? 0;
});

const isTranslating = computed(
  () => translateProgress.value !== null && currentLang.value !== 'original',
);

const statusDotClass = computed(() => {
  switch (status.value) {
    case 'running': return 'bg-primary animate-pulse';
    case 'done':    return 'bg-success';
    case 'error':   return 'bg-destructive';
    default:        return 'bg-muted-foreground/50';
  }
});

const statusLabel = computed(() => {
  const isOriginal = currentLang.value === 'original';
  switch (status.value) {
    case 'running':
      return isOriginal ? t('player.meta.transcribing') : t('player.meta.translating');
    case 'done':
      return isOriginal ? t('player.meta.transcribed') : t('player.meta.translated');
    case 'error':
      return t('player.meta.failed');
    default:
      return '';
  }
});

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
  translateRetryNotice,
  transcriptReady: isOriginalTranscribeDone,
  transcriptNotReadyMessage: t('player.errors.ORIGINAL_NOT_READY'),
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
  subtitleView.load();
  void diarize.refresh();
  void loadCachedLangs();
  openOriginalStream();
  // Stamp `last_opened_at` so the library re-sorts to put this video
  // at the top. Best-effort: errors are swallowed since the library
  // still functions on the old timestamp.
  void $fetch(`/api/video/open?hash=${hash.value}`, { method: 'POST' }).catch(() => {});
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
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      <PlayerToolbar
        :video-name="videoName"
        :is-translating="isTranslating"
        :translate-progress="translateProgress"
        :status-label="statusLabel"
        :status-dot-class="statusDotClass"
        :cue-count="cues.length"
        :suspect-count="suspectCount"
        :is-diarizing="!!isDiarizing"
        :speaker-count="speakerCount"
        :translate-retry-notice="translateRetryNotice"
        :current-lang="currentLang"
        :supported-langs="SUPPORTED_LANGS"
        :lang-status="langStatus"
        :playback-rate="playbackRate"
        :speeds="SPEEDS"
        :can-run-diarize="!!canRunDiarize"
        :diarize-action-failed="!!diarizeActionFailed"
        @cancel-translation="showCancelDialog = true"
        @change-lang="onLangChange"
        @show-export="showExport = true"
        @set-playback-rate="setPlaybackRate"
        @show-settings="showSettings = true"
        @show-help="showHelp = true"
        @run-diarize="handleRunDiarize"
        @show-retranscribe="showRetranscribeDialog = true"
      />

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
            <WaveformBar
              v-if="waveformPeaks"
              :peaks="waveformPeaks"
              :current-time="currentTime"
              :duration="duration"
              :is-playing="isPlaying"
              :playback-rate="playbackRate"
              class="pointer-events-auto h-7 w-full"
              @seek="onWaveformSeek"
            />
            <input
              v-else
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
          <!-- "Index" framing instead of "Subtitles": main video already
               renders captions on the surface; this panel exists for
               search / navigation / review. Naming the role explicitly
               (instead of dimming the panel visually) is the cheaper
               fix for the perceived duplication; the (i) tooltip
               keeps the longer explanation available without taking
               a whole second line. -->
          <h2 class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ t('player.indexTitle') }}
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  :aria-label="t('player.indexSubtitle')"
                >
                  <Info class="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent class="max-w-xs">{{ t('player.indexSubtitle') }}</TooltipContent>
            </Tooltip>
            · <span class="normal-case tracking-normal text-foreground">{{ langLabel(currentLang, SUPPORTED_LANGS.find((l) => l.code === currentLang)?.label ?? currentLang) }}</span>
          </h2>
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
              <div class="flex items-center gap-2">
                <div class="flex-1">
                  <SearchBar
                    ref="searchBarRef"
                    :cues="cues"
                    @update:query="searchQuery = $event"
                    @update:match-idx="searchMatchIdx = $event"
                  />
                </div>
                <ViewToggle
                  v-if="subtitleView.toggleVisible.value"
                  :model-value="subtitleView.view.value"
                  :speaker-count="diarize.status.value && diarize.status.value.status === 'done' ? (diarize.status.value.finalSpeakerCount ?? 0) : 0"
                  @update:model-value="subtitleView.setView"
                />
              </div>

              <UnknownWarningRibbon
                v-if="isDiarizeDone && diarize.status.value && diarize.status.value.status === 'done' && (diarize.status.value.unknownRatio ?? 0) >= 0.15"
                :unknown-duration-s="diarize.status.value.unknownDurationS ?? 0"
                :unknown-ratio="diarize.status.value.unknownRatio ?? 0"
                :current-top-k="diarize.status.value.topK ?? 2"
                @retry-with-more-speakers="handleChangeTopK"
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
                    v-else-if="item.kind === 'speakerHeader'"
                    class="list-none"
                  >
                    <SpeakerHeader
                      :speaker-id="item.speakerId"
                      :color-index="speakerColorIndex(item.speakerId, diarize.appearanceOrder.value)"
                      :display-name="diarize.displayNames.value.get(item.speakerId) ?? null"
                      :ratio="item.ratio"
                      :duration-s="item.durationS"
                      :current-top-k="diarize.status.value && diarize.status.value.status === 'done' ? (diarize.status.value.topK ?? 2) : 2"
                      @rename="handleRenameSpeaker"
                      @change-top-k="handleChangeTopK"
                    />
                  </li>
                  <li
                    v-else
                    :data-cue-idx="item.idx"
                    role="button"
                    tabindex="0"
                    class="relative flex cursor-pointer items-baseline gap-2 rounded-md border border-transparent px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    :class="[
                      item.idx === activeIdx
                        ? 'bg-primary/10 font-medium text-foreground'
                        : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground',
                      item.cue.quality === 'suspect' && item.idx !== activeIdx ? 'border-warning/40' : '',
                      searchMatchIdx === item.idx ? 'ring-2 ring-yellow-500/60' : '',
                    ]"
                    :title="item.cue.quality === 'suspect' ? t('player.suspectCueTitle') : ''"
                    @click="jumpTo(item.cue.startMs)"
                    @keydown="(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); jumpTo(item.cue.startMs); } }"
                  >
                    <span
                      v-if="showDiarizeUI && item.speakerId"
                      aria-hidden="true"
                      class="pointer-events-none absolute inset-y-0 left-0 w-0.5"
                      :style="{ background: speakerThreadColor(item.speakerId) }"
                    />
                    <span
                      v-if="subtitleView.view.value === 'list' && showDiarizeUI && item.speakerId"
                      class="inline-flex w-6 shrink-0 justify-start"
                    >
                      <SpeakerChip
                        v-if="item.firstOfRun"
                        :speaker-id="item.speakerId"
                        :color-index="speakerColorIndex(item.speakerId, diarize.appearanceOrder.value)"
                        :display-name="diarize.displayNames.value.get(item.speakerId) ?? null"
                      />
                    </span>
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
                :transcript-ready="isOriginalTranscribeDone"
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

    <PlayerDialogs
      v-model:show-help="showHelp"
      v-model:show-cancel-dialog="showCancelDialog"
      v-model:show-retranscribe-dialog="showRetranscribeDialog"
      v-model:show-settings="showSettings"
      :shortcuts="SHORTCUTS"
      :retranscribed-lang-count="retranscribedLangCount"
      :retranscribing="retranscribing"
      :subtitle-style="subtitleStyle"
      :is-custom-color="isCustomColor"
      :color-presets="COLOR_PRESETS"
      @cancel-translation="cancelTranslation"
      @confirm-retranscribe="confirmRetranscribe"
      @update-subtitle-font-size="subtitleStyle.fontSize = $event"
      @update-subtitle-color="subtitleStyle.color = $event"
      @update-subtitle-bg-opacity="subtitleStyle.bgOpacity = $event"
      @reset-subtitle-style="resetSubtitleStyle"
    />
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
