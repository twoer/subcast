<script setup lang="ts">
interface Settings {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  ollamaModel: string;
  cacheLimitGB: number;
  silenceThresholdMs: number;
  debugMode: boolean;
}
interface Hardware {
  totalMemoryGB: number;
  cpuCount: number;
  cpuModel: string;
  platform: string;
  arch: string;
  gpu: string;
  tier: 'entry' | 'standard' | 'recommended' | 'high';
  recommended: { whisperModel: string; ollamaModel: string };
  lanIp?: string;
}
interface Resp {
  settings: Settings;
  hardware: Hardware;
}

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const;
const TIER_LABEL: Record<Hardware['tier'], string> = {
  entry: '入门',
  standard: '标准',
  recommended: '推荐',
  high: '高配',
};

const settings = ref<Settings | null>(null);
const hardware = ref<Hardware | null>(null);
const draft = ref<Settings | null>(null);
const saving = ref(false);
const savedAt = ref<number | null>(null);
const errMsg = ref<string | null>(null);

async function load() {
  errMsg.value = null;
  try {
    const data = await $fetch<Resp>('/api/settings');
    settings.value = data.settings;
    hardware.value = data.hardware;
    draft.value = { ...data.settings };
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'failed to load';
  }
}

async function save() {
  if (!draft.value) return;
  saving.value = true;
  errMsg.value = null;
  try {
    const data = await $fetch<{ settings: Settings }>('/api/settings', {
      method: 'PUT',
      body: draft.value,
    });
    settings.value = data.settings;
    draft.value = { ...data.settings };
    savedAt.value = Date.now();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'failed to save';
  } finally {
    saving.value = false;
  }
}

function applyRecommended() {
  if (!draft.value || !hardware.value) return;
  draft.value.whisperModel = hardware.value.recommended.whisperModel as Settings['whisperModel'];
  draft.value.ollamaModel = hardware.value.recommended.ollamaModel;
}

const dirty = computed(() => {
  if (!settings.value || !draft.value) return false;
  return JSON.stringify(settings.value) !== JSON.stringify(draft.value);
});

onMounted(() => void load());
</script>

<template>
  <main class="min-h-screen p-8 bg-gray-50">
    <div class="max-w-2xl mx-auto">
      <header class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-bold">Settings</h1>
        <NuxtLink to="/" class="text-blue-600 hover:underline text-sm">← Back</NuxtLink>
      </header>

      <p v-if="errMsg" class="mb-4 text-red-600 text-sm bg-red-50 border border-red-200 rounded p-3">
        {{ errMsg }}
      </p>

      <section v-if="hardware" class="mb-6 bg-white rounded p-5 border border-gray-200">
        <h2 class="text-sm uppercase tracking-wide text-gray-700 mb-3">Hardware</h2>
        <dl class="grid grid-cols-2 gap-y-1.5 text-sm">
          <dt class="text-gray-500">Tier</dt>
          <dd class="font-medium">
            {{ TIER_LABEL[hardware.tier] }}
            <span class="text-xs text-gray-500 ml-2">({{ hardware.tier }})</span>
          </dd>
          <dt class="text-gray-500">RAM</dt>
          <dd>{{ hardware.totalMemoryGB }} GB</dd>
          <dt class="text-gray-500">CPU</dt>
          <dd class="truncate" :title="hardware.cpuModel">
            {{ hardware.cpuCount }}× {{ hardware.cpuModel }}
          </dd>
          <dt class="text-gray-500">GPU</dt>
          <dd>{{ hardware.gpu }}</dd>
          <dt class="text-gray-500">Platform</dt>
          <dd>{{ hardware.platform }} ({{ hardware.arch }})</dd>
          <dt class="text-gray-500">Recommended</dt>
          <dd class="text-xs font-mono">
            whisper={{ hardware.recommended.whisperModel }} · ollama={{ hardware.recommended.ollamaModel }}
          </dd>
        </dl>
        <button
          class="mt-4 text-xs px-3 py-1.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
          @click="applyRecommended"
        >Apply recommended → draft</button>
      </section>

      <section v-if="draft" class="bg-white rounded p-5 border border-gray-200 space-y-5">
        <h2 class="text-sm uppercase tracking-wide text-gray-700">Settings</h2>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Whisper model
          </label>
          <select
            v-model="draft.whisperModel"
            class="w-full px-3 py-2 border border-gray-300 rounded text-sm"
          >
            <option v-for="m in WHISPER_MODELS" :key="m" :value="m">
              {{ m }}
              <template v-if="hardware && m === hardware.recommended.whisperModel">
                ← recommended
              </template>
            </option>
          </select>
          <p class="text-xs text-gray-500 mt-1">
            Bigger = more accurate but slower. Changes apply to new transcribe tasks.
          </p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Ollama model
          </label>
          <input
            v-model="draft.ollamaModel"
            type="text"
            class="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono"
            placeholder="qwen2.5:7b"
          />
          <p class="text-xs text-gray-500 mt-1">
            Use the exact tag visible in <code>ollama list</code>. Recommended:
            <code>{{ hardware?.recommended.ollamaModel }}</code>.
          </p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Cache size limit
            <span class="text-gray-500 ml-2">{{ draft.cacheLimitGB }} GB</span>
          </label>
          <input
            v-model.number="draft.cacheLimitGB"
            type="range"
            min="1"
            max="100"
            step="1"
            class="w-full"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Silence threshold
            <span class="text-gray-500 ml-2">{{ Math.round(draft.silenceThresholdMs / 1000) }}s</span>
          </label>
          <input
            v-model.number="draft.silenceThresholdMs"
            type="range"
            min="3000"
            max="60000"
            step="1000"
            class="w-full"
          />
          <p class="text-xs text-gray-500 mt-1">
            Inter-cue gaps ≥ this duration get a 「── 无语音 ──」divider in the cue list.
          </p>
        </div>

        <div class="flex items-center gap-2">
          <input
            id="debug"
            v-model="draft.debugMode"
            type="checkbox"
          />
          <label for="debug" class="text-sm text-gray-700">
            Debug mode (keep raw paths/filenames in JSONL logs)
          </label>
        </div>

        <div class="flex items-center gap-3 pt-2 border-t border-gray-200">
          <button
            :disabled="!dirty || saving"
            class="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            @click="save"
          >
            {{ saving ? 'Saving…' : dirty ? 'Save' : 'Saved' }}
          </button>
          <button
            v-if="dirty"
            class="text-sm text-gray-500 hover:underline"
            @click="draft = { ...settings! }"
          >Reset</button>
          <span v-if="savedAt" class="text-xs text-gray-500">
            Last saved: {{ new Date(savedAt).toLocaleTimeString() }}
          </span>
        </div>
      </section>

      <p v-if="!hardware && !errMsg" class="text-center text-gray-500 mt-8">
        Loading hardware info…
      </p>
    </div>
  </main>
</template>
