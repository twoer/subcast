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
  if (track) {
    track.mode = 'showing';
    return track;
  }
  return null;
}

function clearTrack() {
  const track = getOrCreateTrack();
  if (!track) return;
  // Iterate backwards because removeCue mutates the live list
  const list = track.cues;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    track.removeCue(list[i]!);
  }
}

function addCueToTrack(cue: CueData) {
  const track = getOrCreateTrack();
  if (!track) return;
  try {
    track.addCue(new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text));
  } catch {
    /* VTTCue may not be available in some browsers */
  }
}

function rebuildTrackFor(lang: string) {
  clearTrack();
  for (const c of cuesByLang.value[lang] ?? []) addCueToTrack(c);
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
  if (esByLang[lang]) return; // already open
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
      // append-only update to track
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
  // Reflect status of the just-selected language (if known)
  status.value = langStatus.value[newLang] ?? 'idle';
  if (newLang === 'original') {
    if ((cuesByLang.value.original?.length ?? 0) === 0 && !esByLang.original) {
      openOriginalStream();
    }
    return;
  }
  // Need to (re)open translate stream if not already loaded or in flight
  if (!cuesByLang.value[newLang] || cuesByLang.value[newLang]!.length === 0) {
    openTranslateStream(newLang);
  } else if (langStatus.value[newLang] !== 'done' && !esByLang[newLang]) {
    openTranslateStream(newLang);
  }
}

onMounted(() => {
  openOriginalStream();
});

onBeforeUnmount(() => {
  for (const k of Object.keys(esByLang)) esByLang[k]?.close();
});

watch(activeIdx, (idx) => {
  if (idx < 0) return;
  const el = document.querySelector(`[data-cue-idx="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

      <p v-if="errMsg" class="mb-4 text-red-400 text-sm bg-red-950/40 p-3 rounded">{{ errMsg }}</p>

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
          <h2 class="text-sm text-gray-300 uppercase tracking-wide">Subtitles · {{ currentLang }}</h2>
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
  </main>
</template>
