<!-- app/pages/player/[hash].vue -->
<script setup lang="ts">
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
  { code: 'original', label: 'Original' },
  { code: 'zh-CN', label: '中文（简体）' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en-US', label: 'English' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'es-ES', label: 'Español' },
];

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

interface SubtitleStyle {
  fontSize: number; // em
  color: string;
  bgOpacity: number; // 0..1
}
const DEFAULT_STYLE: SubtitleStyle = { fontSize: 1.0, color: '#ffffff', bgOpacity: 0.6 };
const STYLE_KEY = 'subcast.subtitleStyle';

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: 'Space / K', action: 'Play / Pause' },
  { keys: '← / →', action: 'Seek -/+ 5s' },
  { keys: 'J / L', action: 'Seek -/+ 10s (YouTube)' },
  { keys: '↑ / ↓', action: 'Volume +/- 10%' },
  { keys: '< / >', action: 'Speed -/+ one step' },
  { keys: 'M', action: 'Toggle mute' },
  { keys: 'F', action: 'Toggle fullscreen' },
  { keys: 'C', action: 'Toggle subtitles' },
  { keys: '1-9', action: 'Jump to 10%-90% of video' },
  { keys: '?', action: 'Show this help' },
  { keys: 'Esc', action: 'Close dialog' },
];

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
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
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

function handleSseError(e: Event, lang: string) {
  const raw = (e as MessageEvent).data;
  let detail = 'connection lost';
  if (raw) {
    try {
      const data = JSON.parse(raw);
      detail = `${data.code}: ${data.msg}`;
    } catch { /* ignore */ }
  }
  langStatus.value[lang] = 'error';
  if (currentLang.value === lang) {
    errMsg.value = detail;
    status.value = 'error';
  }
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
  openOriginalStream();
  window.addEventListener('keydown', onKeyDown);
});

onBeforeUnmount(() => {
  for (const k of Object.keys(esByLang)) esByLang[k]?.close();
  window.removeEventListener('keydown', onKeyDown);
});

watch(activeIdx, (idx) => {
  if (idx < 0) return;
  const el = document.querySelector(`[data-cue-idx="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

watch(playbackRate, (r) => {
  if (videoRef.value) videoRef.value.playbackRate = r;
});
</script>

<template>
  <main class="min-h-screen bg-gray-950 text-gray-100">
    <div class="max-w-5xl mx-auto p-6">
      <header class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <NuxtLink to="/" class="text-blue-300 hover:underline text-sm">← Back</NuxtLink>
        <div class="flex items-center gap-2 text-sm">
          <select
            :value="currentLang"
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
            @change="onLangChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="l in SUPPORTED_LANGS" :key="l.code" :value="l.code">
              {{ l.label }}
              <template v-if="langStatus[l.code] === 'done'">✓</template>
              <template v-else-if="langStatus[l.code] === 'running'">…</template>
              <template v-else-if="langStatus[l.code] === 'error'">✗</template>
            </option>
          </select>
          <select
            :value="playbackRate"
            class="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"
            @change="setPlaybackRate(parseFloat(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}x</option>
          </select>
          <button
            class="px-2 py-1 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 text-xs"
            title="Subtitle style"
            @click="showSettings = true"
          >Aa</button>
          <button
            class="px-2 py-1 rounded bg-gray-800 border border-gray-700 hover:bg-gray-700 text-xs"
            title="Keyboard shortcuts (?)"
            @click="showHelp = true"
          >?</button>
          <span class="text-gray-400 font-mono text-xs">{{ hash.slice(0, 12) }}…</span>
          <span
            v-if="fromCache"
            class="px-2 py-0.5 rounded bg-blue-900 text-blue-200 text-xs"
          >cache</span>
          <span
            class="px-2 py-0.5 rounded text-xs"
            :class="{
              'bg-yellow-700 text-yellow-100': status === 'running',
              'bg-green-700 text-green-100': status === 'done',
              'bg-red-700 text-red-100': status === 'error',
              'bg-gray-700 text-gray-200': status === 'idle',
            }"
          >{{ status }}</span>
          <span
            v-if="translateProgress !== null && currentLang !== 'original'"
            class="px-2 py-0.5 rounded bg-purple-900 text-purple-200 text-xs"
          >翻译中 {{ translateProgress }}%</span>
        </div>
      </header>

      <p v-if="errMsg" class="mb-4 text-red-400 text-sm bg-red-950/40 p-3 rounded">
        {{ errMsg }}
      </p>

      <div class="bg-black rounded overflow-hidden">
        <video
          ref="videoRef"
          :src="`/api/video?hash=${hash}`"
          controls
          class="w-full max-h-[60vh]"
          crossorigin="anonymous"
          @timeupdate="currentTime = ($event.target as HTMLVideoElement).currentTime"
        >
          <track default kind="subtitles" srclang="auto" :label="currentLang" />
        </video>
      </div>

      <section class="mt-6">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm text-gray-300 uppercase tracking-wide">
            Subtitles · {{ currentLang }}
          </h2>
          <div class="flex items-center gap-3 text-xs text-gray-500">
            <span>{{ cues.length }} cues</span>
            <span
              v-if="suspectCount > 0"
              class="px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300"
              title="Whisper marked these chunks as low confidence"
            >{{ suspectCount }} suspect</span>
          </div>
        </div>
        <ul class="space-y-1 max-h-[40vh] overflow-y-auto bg-gray-900/50 rounded p-2 font-mono text-sm">
          <template v-for="(item, i) in listItems" :key="i">
            <li
              v-if="item.kind === 'silence'"
              class="text-center text-gray-600 text-xs select-none py-1"
            >── 无语音 {{ Math.round(item.durationS) }}s ──</li>
            <li
              v-else
              :data-cue-idx="item.idx"
              class="px-3 py-1.5 rounded cursor-pointer transition-colors border"
              :class="[
                item.idx === activeIdx ? 'bg-blue-600 text-white border-blue-400' : 'hover:bg-gray-800 text-gray-300 border-transparent',
                item.cue.quality === 'suspect' ? 'border-amber-500/60' : '',
              ]"
              :title="item.cue.quality === 'suspect' ? '转写质量可能异常（已重试 2 次）' : ''"
              @click="jumpTo(item.cue.startMs)"
            >
              <span class="text-xs opacity-70 mr-3">{{ fmtTime(item.cue.startMs) }}</span>
              <span>{{ item.cue.text }}</span>
              <span
                v-if="item.cue.quality === 'suspect'"
                class="ml-2 text-amber-400 text-xs"
              >⚠</span>
            </li>
          </template>
          <li v-if="cues.length === 0 && status === 'running'" class="text-gray-500 text-center py-4">
            <template v-if="currentLang === 'original'">Transcribing… first cue in 30-60s</template>
            <template v-else>Translating…</template>
          </li>
        </ul>
      </section>
    </div>

    <!-- Help dialog -->
    <div
      v-if="showHelp"
      class="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      @click.self="showHelp = false"
    >
      <div class="bg-gray-900 rounded-lg p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Keyboard shortcuts</h3>
          <button
            class="text-gray-400 hover:text-gray-100"
            @click="showHelp = false"
          >✕</button>
        </div>
        <table class="w-full text-sm">
          <tbody>
            <tr v-for="s in SHORTCUTS" :key="s.keys" class="border-b border-gray-800">
              <td class="py-1.5 font-mono text-blue-300">{{ s.keys }}</td>
              <td class="py-1.5 text-gray-300">{{ s.action }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Subtitle style settings -->
    <div
      v-if="showSettings"
      class="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      @click.self="showSettings = false"
    >
      <div class="bg-gray-900 rounded-lg p-6 w-full max-w-sm">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">Subtitle style</h3>
          <button
            class="text-gray-400 hover:text-gray-100"
            @click="showSettings = false"
          >✕</button>
        </div>
        <div class="space-y-4 text-sm">
          <div>
            <label class="block text-gray-300 mb-1">
              Font size <span class="text-gray-500 ml-2">{{ subtitleStyle.fontSize.toFixed(2) }}em</span>
            </label>
            <input
              v-model.number="subtitleStyle.fontSize"
              type="range"
              min="0.6"
              max="2.0"
              step="0.05"
              class="w-full"
            />
          </div>
          <div>
            <label class="block text-gray-300 mb-1">Color</label>
            <input
              v-model="subtitleStyle.color"
              type="color"
              class="h-8 w-16 rounded"
            />
          </div>
          <div>
            <label class="block text-gray-300 mb-1">
              Background opacity <span class="text-gray-500 ml-2">{{ Math.round(subtitleStyle.bgOpacity * 100) }}%</span>
            </label>
            <input
              v-model.number="subtitleStyle.bgOpacity"
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="w-full"
            />
          </div>
          <button
            class="text-xs text-gray-400 hover:text-gray-200 underline"
            @click="subtitleStyle = { ...DEFAULT_STYLE }"
          >Reset to defaults</button>
        </div>
      </div>
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
