<!-- app/pages/player/[hash].vue -->
<script setup lang="ts">
interface CueData {
  chunkIdx: number;
  startMs: number;
  endMs: number;
  text: string;
}

const route = useRoute();
const hash = computed(() => String(route.params.hash));

const videoRef = ref<HTMLVideoElement | null>(null);
const cues = ref<CueData[]>([]);
const status = ref<'idle' | 'running' | 'done' | 'error'>('idle');
const errMsg = ref<string | null>(null);
const fromCache = ref(false);
const currentTime = ref(0);

let es: EventSource | null = null;

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

function addCueToTrack(cue: CueData) {
  const track = getOrCreateTrack();
  if (!track) return;
  try {
    track.addCue(new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text));
  } catch {
    // VTTCue may not be available in some browsers; ignore silently
  }
}

const activeIdx = computed(() => {
  const t = currentTime.value * 1000;
  return cues.value.findIndex((c) => c.startMs <= t && t < c.endMs);
});

function jumpTo(ms: number) {
  if (videoRef.value) videoRef.value.currentTime = ms / 1000;
}

onMounted(() => {
  status.value = 'running';
  es = new EventSource(`/api/transcribe?hash=${hash.value}`);

  es.addEventListener('status', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    if (data.status === 'running') status.value = 'running';
    if (data.fromCache) fromCache.value = true;
  });

  es.addEventListener('cue', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as CueData;
    cues.value.push(data);
    addCueToTrack(data);
  });

  es.addEventListener('done', () => {
    status.value = 'done';
    es?.close();
  });

  es.addEventListener('error', (e) => {
    const raw = (e as MessageEvent).data;
    if (raw) {
      try {
        const data = JSON.parse(raw);
        errMsg.value = `${data.code}: ${data.msg}`;
      } catch {
        errMsg.value = 'connection lost';
      }
    } else {
      errMsg.value = 'connection lost';
    }
    status.value = 'error';
    es?.close();
  });
});

onBeforeUnmount(() => {
  es?.close();
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
      <header class="flex items-center justify-between mb-4">
        <NuxtLink to="/" class="text-blue-300 hover:underline text-sm">← Back</NuxtLink>
        <div class="flex items-center gap-2 text-sm">
          <span class="text-gray-400 font-mono">{{ hash.slice(0, 12) }}…</span>
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
          <track default kind="subtitles" srclang="auto" label="Original" />
        </video>
      </div>

      <section class="mt-6">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm text-gray-300 uppercase tracking-wide">Subtitles</h2>
          <span class="text-xs text-gray-500">{{ cues.length }} cues</span>
        </div>
        <ul class="space-y-1 max-h-[40vh] overflow-y-auto bg-gray-900/50 rounded p-2 font-mono text-sm">
          <li
            v-for="(cue, idx) in cues"
            :key="cue.chunkIdx"
            :data-cue-idx="idx"
            class="px-3 py-1.5 rounded cursor-pointer transition-colors"
            :class="idx === activeIdx ? 'bg-blue-600 text-white' : 'hover:bg-gray-800 text-gray-300'"
            @click="jumpTo(cue.startMs)"
          >
            <span class="text-xs opacity-70 mr-3">{{ fmtTime(cue.startMs) }}</span>
            <span>{{ cue.text }}</span>
          </li>
          <li v-if="cues.length === 0 && status === 'running'" class="text-gray-500 text-center py-4">
            Transcribing… first cue in 30-60s
          </li>
        </ul>
      </section>
    </div>
  </main>
</template>
