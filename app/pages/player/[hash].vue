<!-- app/pages/player/[hash].vue -->
<script setup lang="ts">
import {
  Type, Keyboard, ArrowLeft, Check, X as XIcon, AlertCircle, AlertTriangle, Loader2,
  Play, Pause, Volume2, Volume1, VolumeX, Captions, CaptionsOff,
  Maximize, Minimize, RotateCcw, Palette,
} from 'lucide-vue-next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const { t, te } = useI18n();

interface CueData {
  startMs: number;
  endMs: number;
  text: string;
  chunkIdx?: number;
  quality?: 'ok' | 'suspect';
}

type ListItem =
  | { kind: 'cue'; cue: CueData; idx: number }
  | { kind: 'silence'; afterIdx: number; durationS: number };

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

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

interface SubtitleStyle {
  fontSize: number; // em
  color: string;
  bgOpacity: number; // 0..1
}
const DEFAULT_STYLE: SubtitleStyle = { fontSize: 1.0, color: '#ffffff', bgOpacity: 0.6 };
const STYLE_KEY = 'subcast.subtitleStyle';
const RATE_KEY = 'subcast.playbackRate';

const COLOR_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '#ffffff', label: 'White' },
  { value: '#facc15', label: 'Yellow' },
  { value: '#fb923c', label: 'Amber' },
  { value: '#22d3ee', label: 'Cyan' },
  { value: '#4ade80', label: 'Green' },
  { value: '#f472b6', label: 'Pink' },
  { value: '#000000', label: 'Black' },
];

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
  switch (s) {
    case 'running':
      return 'bg-primary/10 text-primary border-transparent hover:bg-primary/15';
    case 'done':
      return 'border-success/40 bg-success/10 text-success';
    case 'error':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'cache':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'translating':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'suspect':
      return 'border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning';
    case 'idle':
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

const route = useRoute();
const hash = computed(() => String(route.params.hash));

const videoRef = ref<HTMLVideoElement | null>(null);
const currentLang = ref<string>('original');
const cuesByLang = ref<Record<string, CueData[]>>({ original: [] });
const cues = computed(() => cuesByLang.value[currentLang.value] ?? []);

const status = ref<'idle' | 'running' | 'done' | 'error'>('idle');
const langStatus = ref<Record<string, 'idle' | 'running' | 'done' | 'error'>>({});
const errMsg = ref<string | null>(null);
const fromCache = ref(false);
const currentTime = ref(0);
const translateProgress = ref<number | null>(null);

// Slice 7 player UX
const playbackRate = ref(1.0);
const showHelp = ref(false);
const showSettings = ref(false);
const subsVisible = ref(true);
const subtitleStyle = ref<SubtitleStyle>({ ...DEFAULT_STYLE });
const customColorInput = ref<HTMLInputElement | null>(null);

const isCustomColor = computed(
  () => !COLOR_PRESETS.some((p) => p.value.toLowerCase() === subtitleStyle.value.color.toLowerCase()),
);

const { px: cueFontPx, load: loadCueFontSize } = useCueListFontSize();

async function loadCachedLangs() {
  try {
    const res = await $fetch<{ items: Array<{ sha256: string; langs: string[] }> }>('/api/cache/list');
    const entry = res.items.find((i) => i.sha256 === hash.value);
    if (!entry) return;
    for (const lang of entry.langs) {
      if (lang === 'original') continue;
      if (langStatus.value[lang]) continue; // don't clobber active session state
      langStatus.value[lang] = 'done';
    }
  } catch {
    /* network blip — dropdown just won't show pre-marks */
  }
}

// Custom video controls state
const isPlaying = ref(false);
const duration = ref(0);
const volume = ref(1);
const muted = ref(false);
const isFullscreen = ref(false);
const controlsVisible = ref(true);
let hideHandle: ReturnType<typeof setTimeout> | null = null;

function onLoadedMetadata() {
  const v = videoRef.value;
  if (!v) return;
  duration.value = v.duration;
  v.playbackRate = playbackRate.value;
}
function onPlayState() {
  const v = videoRef.value;
  if (!v) return;
  isPlaying.value = !v.paused;
  scheduleHide();
}
function onVolumeEvent() {
  const v = videoRef.value;
  if (!v) return;
  volume.value = v.volume;
  muted.value = v.muted;
}
function onSeek(e: Event) {
  const v = videoRef.value;
  if (!v) return;
  v.currentTime = parseFloat((e.target as HTMLInputElement).value);
}
function setVolume(e: Event) {
  const v = videoRef.value;
  if (!v) return;
  v.volume = parseFloat((e.target as HTMLInputElement).value);
  v.muted = false;
}
function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement;
}
function scheduleHide() {
  if (hideHandle) clearTimeout(hideHandle);
  if (isPlaying.value) {
    hideHandle = setTimeout(() => { controlsVisible.value = false; }, 1800);
  }
}
function showControls() {
  controlsVisible.value = true;
  scheduleHide();
}
function onContainerLeave() {
  if (isPlaying.value) controlsVisible.value = false;
}

const cueFontSize = computed(() => `${subtitleStyle.value.fontSize}em`);
const cueColor = computed(() => subtitleStyle.value.color);
const cueBg = computed(() => {
  const a = subtitleStyle.value.bgOpacity;
  return `rgba(0, 0, 0, ${a})`;
});

const esByLang: Record<string, EventSource | null> = {};

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function getOrCreateTrack(): TextTrack | null {
  const v = videoRef.value;
  if (!v) return null;
  let track = v.textTracks[0];
  if (!track) {
    const el = v.querySelector('track');
    if (el) track = (el as HTMLTrackElement).track;
  }
  return track ?? null;
}

function applyTrackVisibility() {
  const t = getOrCreateTrack();
  if (!t) return;
  t.mode = subsVisible.value ? 'showing' : 'hidden';
}

function clearTrack() {
  const t = getOrCreateTrack();
  if (!t?.cues) return;
  for (let i = t.cues.length - 1; i >= 0; i--) t.removeCue(t.cues[i]!);
}

function addCueToTrack(cue: CueData) {
  const t = getOrCreateTrack();
  if (!t) return;
  try {
    t.addCue(new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text));
  } catch {
    /* unsupported in some browsers */
  }
}

function rebuildTrackFor(lang: string) {
  clearTrack();
  for (const c of cuesByLang.value[lang] ?? []) addCueToTrack(c);
  applyTrackVisibility();
}

const activeIdx = computed(() => {
  const t = currentTime.value * 1000;
  return cues.value.findIndex((c) => c.startMs <= t && t < c.endMs);
});

const listItems = computed<ListItem[]>(() => {
  const out: ListItem[] = [];
  cues.value.forEach((c, idx) => {
    if (idx > 0) {
      const prev = cues.value[idx - 1]!;
      const gap = c.startMs - prev.endMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        out.push({ kind: 'silence', afterIdx: idx - 1, durationS: gap / 1000 });
      }
    }
    out.push({ kind: 'cue', cue: c, idx });
  });
  return out;
});

const suspectCount = computed(
  () => cues.value.filter((c) => c.quality === 'suspect').length,
);

function jumpTo(ms: number) {
  if (videoRef.value) videoRef.value.currentTime = ms / 1000;
}

function setPlaybackRate(rate: number) {
  playbackRate.value = rate;
  if (videoRef.value) videoRef.value.playbackRate = rate;
}

function bumpSpeed(delta: number) {
  const i = SPEEDS.indexOf(playbackRate.value);
  const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + delta))]!;
  setPlaybackRate(next);
}

function togglePlay() {
  const v = videoRef.value;
  if (!v) return;
  if (v.paused) void v.play();
  else v.pause();
}

function seekBy(deltaS: number) {
  const v = videoRef.value;
  if (!v) return;
  v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + deltaS));
}

function bumpVolume(delta: number) {
  const v = videoRef.value;
  if (!v) return;
  v.volume = Math.max(0, Math.min(1, v.volume + delta));
  v.muted = false;
}

function toggleMute() {
  const v = videoRef.value;
  if (!v) return;
  v.muted = !v.muted;
}

function toggleFullscreen() {
  const v = videoRef.value;
  if (!v) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void v.requestFullscreen();
}

function toggleSubs() {
  subsVisible.value = !subsVisible.value;
  applyTrackVisibility();
}

function jumpPercent(pct: number) {
  const v = videoRef.value;
  if (!v || !Number.isFinite(v.duration)) return;
  v.currentTime = (v.duration * pct) / 100;
}

function shouldIgnore(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.getAttribute('role') === 'button' || tag === 'BUTTON' || tag === 'A') return true;
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (shouldIgnore(e)) return;

  if (showHelp.value || showSettings.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      showHelp.value = false;
      showSettings.value = false;
    }
    return;
  }

  switch (e.key) {
    case ' ':
    case 'k':
    case 'K':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekBy(-5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekBy(5);
      break;
    case 'j':
    case 'J':
      e.preventDefault();
      seekBy(-10);
      break;
    case 'l':
    case 'L':
      e.preventDefault();
      seekBy(10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      bumpVolume(0.1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      bumpVolume(-0.1);
      break;
    case '<':
    case ',':
      e.preventDefault();
      bumpSpeed(-1);
      break;
    case '>':
    case '.':
      e.preventDefault();
      bumpSpeed(1);
      break;
    case 'm':
    case 'M':
      e.preventDefault();
      toggleMute();
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      toggleFullscreen();
      break;
    case 'c':
    case 'C':
      e.preventDefault();
      toggleSubs();
      break;
    case '?':
      e.preventDefault();
      showHelp.value = true;
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        jumpPercent(parseInt(e.key, 10) * 10);
      }
  }
}

function loadStyleFromStorage() {
  if (!import.meta.client) return;
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SubtitleStyle>;
      subtitleStyle.value = { ...DEFAULT_STYLE, ...parsed };
    }
  } catch {
    /* ignore */
  }
}

function loadPlaybackRate() {
  if (!import.meta.client) return;
  try {
    const raw = localStorage.getItem(RATE_KEY);
    if (!raw) return;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && SPEEDS.includes(n)) playbackRate.value = n;
  } catch {
    /* ignore */
  }
}

function saveStyleToStorage() {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(subtitleStyle.value));
  } catch {
    /* ignore quota */
  }
}

watch(subtitleStyle, saveStyleToStorage, { deep: true });

function openOriginalStream() {
  langStatus.value.original = 'running';
  status.value = 'running';
  const es = new EventSource(`/api/transcribe?hash=${hash.value}`);
  esByLang.original = es;
  es.addEventListener('status', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    if (data.fromCache) fromCache.value = true;
    if (currentLang.value === 'original') status.value = 'running';
  });
  es.addEventListener('cue', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as CueData;
    cuesByLang.value.original?.push(data);
    if (currentLang.value === 'original') addCueToTrack(data);
  });
  es.addEventListener('done', () => {
    langStatus.value.original = 'done';
    if (currentLang.value === 'original') status.value = 'done';
    es.close();
    esByLang.original = null;
  });
  es.addEventListener('error', (e) => {
    handleSseError(e, 'original');
    es.close();
    esByLang.original = null;
  });
}

function openTranslateStream(lang: string) {
  if (esByLang[lang]) return;
  langStatus.value[lang] = 'running';
  if (currentLang.value === lang) status.value = 'running';
  cuesByLang.value[lang] = cuesByLang.value[lang] ?? [];
  translateProgress.value = 0;

  const es = new EventSource(`/api/translate?hash=${hash.value}&lang=${lang}`);
  esByLang[lang] = es;

  es.addEventListener('status', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    if (data.fromCache && currentLang.value === lang) fromCache.value = true;
  });
  es.addEventListener('batch-progress', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    if (currentLang.value === lang) translateProgress.value = data.progressPct;
  });
  es.addEventListener('cue-translated', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    const arr = cuesByLang.value[lang]!;
    for (const c of data.cues as CueData[]) arr.push(c);
    if (currentLang.value === lang) {
      for (const c of data.cues as CueData[]) addCueToTrack(c);
    }
  });
  es.addEventListener('batch-retry', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    // eslint-disable-next-line no-console
    console.warn('translate batch-retry', data);
  });
  es.addEventListener('done', () => {
    langStatus.value[lang] = 'done';
    translateProgress.value = null;
    if (currentLang.value === lang) status.value = 'done';
    es.close();
    esByLang[lang] = null;
  });
  es.addEventListener('error', (e) => {
    handleSseError(e, lang);
    es.close();
    esByLang[lang] = null;
  });
}

function friendlyError(code: string): string {
  const key = `player.errors.${code}`;
  return te(key) ? t(key) : t('player.errors.fallback');
}

function handleSseError(e: Event, lang: string) {
  const raw = (e as MessageEvent).data;
  let detail = t('player.errors.disconnected');
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (data.code) detail = friendlyError(data.code);
    } catch { /* ignore */ }
  }
  langStatus.value[lang] = 'error';
  if (currentLang.value === lang) {
    errMsg.value = detail;
    status.value = 'error';
  }
}

const showCancelDialog = ref(false);

async function cancelTranslation() {
  showCancelDialog.value = false;
  const lang = currentLang.value;
  if (!lang || lang === 'original') return;
  try {
    const res = await $fetch<{
      items: Array<{
        kind: 'transcribe' | 'translate';
        id: string;
        videoSha: string;
        targetLang?: string;
        status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
      }>;
    }>('/api/queue/list');
    const task = res.items.find((i) =>
      i.kind === 'translate'
      && i.videoSha === hash.value
      && i.targetLang === lang
      && (i.status === 'running' || i.status === 'queued'),
    );
    if (task) {
      await $fetch(`/api/queue/translate/${task.id}`, { method: 'DELETE' });
    }
  } catch {
    /* server-side cancel may fail; still tear down client state */
  }
  esByLang[lang]?.close();
  esByLang[lang] = null;
  translateProgress.value = null;
  langStatus.value[lang] = 'idle';
  if (currentLang.value === lang) status.value = 'idle';
}

function retryCurrentLang() {
  const lang = currentLang.value;
  if (!lang) return;
  errMsg.value = null;
  status.value = 'idle';
  langStatus.value[lang] = 'idle';
  if (lang === 'original') openOriginalStream();
  else openTranslateStream(lang);
}

function onLangChange(newLang: string) {
  if (newLang === currentLang.value) return;
  errMsg.value = null;
  fromCache.value = false;
  currentLang.value = newLang;
  rebuildTrackFor(newLang);
  status.value = langStatus.value[newLang] ?? 'idle';
  if (newLang === 'original') {
    if ((cuesByLang.value.original?.length ?? 0) === 0 && !esByLang.original) {
      openOriginalStream();
    }
    return;
  }
  if (!cuesByLang.value[newLang] || cuesByLang.value[newLang]!.length === 0) {
    openTranslateStream(newLang);
  } else if (langStatus.value[newLang] !== 'done' && !esByLang[newLang]) {
    openTranslateStream(newLang);
  }
}

onMounted(() => {
  loadStyleFromStorage();
  loadCueFontSize();
  loadPlaybackRate();
  void loadCachedLangs();
  openOriginalStream();
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onBeforeUnmount(() => {
  for (const k of Object.keys(esByLang)) esByLang[k]?.close();
  window.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (hideHandle) clearTimeout(hideHandle);
});

watch(activeIdx, (idx) => {
  if (idx < 0) return;
  const el = document.querySelector(`[data-cue-idx="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

watch(playbackRate, (r) => {
  if (videoRef.value) videoRef.value.playbackRate = r;
  if (import.meta.client) {
    try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* quota */ }
  }
});
</script>

<template>
  <main class="flex min-h-dvh flex-col bg-background px-8 pb-12 xl:h-dvh xl:overflow-hidden xl:pb-6">
    <AppHeader />

    <div class="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col px-4 xl:min-h-0">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3 xl:shrink-0">
        <NuxtLink
          to="/"
          class="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft class="h-4 w-4" />
          {{ t('app.back') }}
        </NuxtLink>

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

          <Button
            variant="outline"
            size="icon-sm"
            class="size-8 [&_svg]:size-3.5"
            :title="t('player.subtitleStyle')"
            :aria-label="t('player.subtitleStyle')"
            @click="showSettings = true"
          >
            <Type />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            class="size-8 [&_svg]:size-3.5"
            :title="`${t('player.shortcuts')} (?)`"
            :aria-label="t('player.shortcuts')"
            @click="showHelp = true"
          >
            <Keyboard />
          </Button>

          <span class="hidden h-7 items-center font-mono text-xs text-muted-foreground sm:inline-flex">{{ hash.slice(0, 12) }}…</span>

          <Badge v-if="fromCache" variant="outline" class="h-7 px-3" :class="statusBadgeClass('cache')">{{ t('player.cache') }}</Badge>
          <Badge variant="outline" class="h-7 px-3" :class="statusBadgeClass(status)">{{ t(`player.status.${status}`) }}</Badge>
          <Badge
            v-if="translateProgress !== null && currentLang !== 'original'"
            variant="outline"
            class="h-7 px-3"
            :class="statusBadgeClass('translating')"
          >{{ t('player.translateProgress', { pct: translateProgress }) }}</Badge>
          <Button
            v-if="translateProgress !== null && currentLang !== 'original'"
            variant="ghost"
            size="icon-sm"
            class="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3.5"
            :title="t('player.cancelTranslation')"
            :aria-label="t('player.cancelTranslation')"
            @click="showCancelDialog = true"
          >
            <XIcon />
          </Button>
        </div>
      </div>

      <div class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,28rem)]">
        <div
          class="group relative flex items-center justify-center overflow-hidden rounded-xl bg-black ring-1 ring-border/60 xl:min-h-0"
          @mousemove="showControls"
          @mouseleave="onContainerLeave"
        >
          <video
            ref="videoRef"
            :src="`/api/video?hash=${hash}`"
            class="block w-full max-h-[60vh] cursor-pointer xl:max-h-full"
            crossorigin="anonymous"
            @timeupdate="currentTime = ($event.target as HTMLVideoElement).currentTime"
            @loadedmetadata="onLoadedMetadata"
            @play="onPlayState"
            @pause="onPlayState"
            @volumechange="onVolumeEvent"
            @click="togglePlay"
          >
            <track default kind="subtitles" srclang="auto" :label="currentLang" />
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
            />

            <div class="pointer-events-auto mt-1.5 flex items-center gap-1 text-white">
              <Button
                variant="ghost"
                size="icon-sm"
                class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                :title="t('player.shortcutDescriptions.playPause')"
                :aria-label="t('player.shortcutDescriptions.playPause')"
                @click="togglePlay"
              >
                <Pause v-if="isPlaying" />
                <Play v-else />
              </Button>

              <span class="ml-1 font-mono text-xs tabular-nums text-white/85">
                {{ fmtClock(currentTime) }} <span class="text-white/45">/</span> {{ fmtClock(duration) }}
              </span>

              <div class="ml-auto flex items-center gap-1">
                <div class="group/vol flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                    :title="t('player.shortcutDescriptions.mute')"
                    :aria-label="t('player.shortcutDescriptions.mute')"
                    @click="toggleMute"
                  >
                    <VolumeX v-if="muted || volume === 0" />
                    <Volume1 v-else-if="volume < 0.5" />
                    <Volume2 v-else />
                  </Button>
                  <input
                    type="range"
                    min="0" max="1" step="0.05"
                    :value="muted ? 0 : volume"
                    :aria-label="t('player.shortcutDescriptions.volume')"
                    class="ml-1 hidden h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/20 accent-primary group-hover/vol:block"
                    @input="setVolume"
                  />
                </div>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                  :class="!subsVisible && 'opacity-50'"
                  :title="t('player.shortcutDescriptions.subs')"
                  :aria-label="t('player.shortcutDescriptions.subs')"
                  :aria-pressed="subsVisible"
                  @click="toggleSubs"
                >
                  <Captions v-if="subsVisible" />
                  <CaptionsOff v-else />
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="size-9 text-white hover:bg-white/15 hover:text-white [&_svg]:size-[18px]"
                  :title="t('player.shortcutDescriptions.fullscreen')"
                  :aria-label="t('player.shortcutDescriptions.fullscreen')"
                  @click="toggleFullscreen"
                >
                  <Minimize v-if="isFullscreen" />
                  <Maximize v-else />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <section class="flex min-w-0 flex-col xl:min-h-0">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('player.subtitles') }} · <span class="normal-case tracking-normal text-foreground">{{ langLabel(currentLang, SUPPORTED_LANGS.find((l) => l.code === currentLang)?.label ?? currentLang) }}</span>
            </h2>
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="font-mono tabular-nums">{{ t('player.cues', { n: cues.length }) }}</span>
              <Badge
                v-if="suspectCount > 0"
                variant="outline"
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
          <ul
            class="surface-1 max-h-[40vh] flex-1 space-y-0.5 overflow-y-auto rounded-xl border border-border/50 bg-muted/30 p-2 font-mono leading-relaxed xl:max-h-none xl:min-h-0"
            :style="{ fontSize: `${cueFontPx}px` }"
          >
          <template v-for="(item, i) in listItems" :key="i">
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
              ]"
              :title="item.cue.quality === 'suspect' ? t('player.suspectCueTitle') : ''"
              @click="jumpTo(item.cue.startMs)"
              @keydown="(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); jumpTo(item.cue.startMs); } }"
            >
              <span
                class="shrink-0 text-xs tabular-nums"
                :class="item.idx === activeIdx ? 'font-semibold text-primary' : 'text-muted-foreground'"
              >{{ fmtTime(item.cue.startMs) }}</span>
              <span class="flex-1">{{ item.cue.text }}</span>
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
        </section>
      </div>
    </div>

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
            />
          </div>
          <div class="space-y-2.5">
            <Label class="text-sm font-medium">{{ t('player.color') }}</Label>
            <div class="flex flex-wrap items-center gap-2">
              <button
                v-for="p in COLOR_PRESETS"
                :key="p.value"
                type="button"
                :title="p.label"
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
              <button
                type="button"
                :title="t('player.customColor')"
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
              <input
                ref="customColorInput"
                v-model="subtitleStyle.color"
                type="color"
                class="sr-only"
                tabindex="-1"
                aria-hidden="true"
              />
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
            />
          </div>
          <div class="flex justify-end border-t border-border/50 pt-4">
            <Button
              variant="ghost"
              size="sm"
              class="text-xs text-muted-foreground hover:text-foreground"
              @click="subtitleStyle = { ...DEFAULT_STYLE }"
            >
              <RotateCcw class="h-3.5 w-3.5" />
              {{ t('player.reset') }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
