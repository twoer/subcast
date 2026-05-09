<script setup lang="ts">
const route = useRoute();
const hash = computed(() => String(route.params.hash));

const lines = ref<string[]>([]);
const status = ref<'idle' | 'running' | 'done' | 'error'>('idle');
const errMsg = ref<string | null>(null);

let es: EventSource | null = null;

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  const k = String(ms % 1000).padStart(3, '0');
  return `${m}:${s}.${k}`;
}

onMounted(() => {
  status.value = 'running';
  es = new EventSource(`/api/transcribe?hash=${hash.value}`);

  es.addEventListener('status', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    if (data.status === 'running') status.value = 'running';
  });

  es.addEventListener('cue', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    lines.value.push(`[${fmt(data.startMs)}-${fmt(data.endMs)}] ${data.text}`);
  });

  es.addEventListener('done', () => {
    status.value = 'done';
    lines.value.push('[done]');
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
</script>

<template>
  <main class="min-h-screen p-8 bg-gray-900 text-gray-100 font-mono">
    <div class="max-w-4xl mx-auto">
      <h1 class="text-xl mb-4">
        <NuxtLink to="/" class="text-blue-300 hover:underline">←</NuxtLink>
        Player — {{ hash.slice(0, 12) }}…
        <span
          class="ml-3 text-sm px-2 py-0.5 rounded"
          :class="{
            'bg-yellow-600': status === 'running',
            'bg-green-600': status === 'done',
            'bg-red-600': status === 'error',
          }"
        >{{ status }}</span>
      </h1>

      <p v-if="errMsg" class="text-red-400 mb-4">{{ errMsg }}</p>

      <pre class="bg-black/40 p-4 rounded overflow-x-auto whitespace-pre-wrap">{{ lines.join('\n') }}</pre>
    </div>
  </main>
</template>
