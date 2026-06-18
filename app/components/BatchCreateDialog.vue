<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CheckCircle2, FileStack, Info, Languages, ListChecks, Play, Sparkles, UsersRound } from 'lucide-vue-next';
import type { BatchOptions } from '#shared/batch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type PresetId =
  | 'transcribe'
  | 'transcribe_translate'
  | 'transcribe_insights'
  | 'transcribe_translate_insights'
  | 'full';

interface Preset {
  id: PresetId;
  icon: typeof ListChecks;
  options: Omit<BatchOptions, 'whisperModel'>;
}

interface PreviewResponse {
  totalVideos: number;
  readyVideos: number;
  queuedVideos: number;
  allReady: boolean;
}

const props = defineProps<{
  open: boolean;
  count: number;
  videoShas: string[];
  reusedCount: number;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'start', value: { preset: PresetId; options: BatchOptions }): void;
}>();

const { t, locale } = useI18n();
const selectedPreset = ref<PresetId>('transcribe_insights');
const whisperModel = ref('base');
const selectedLangs = ref<string[]>(['zh-CN']);
const preview = ref<PreviewResponse | null>(null);
const previewLoading = ref(false);

const presets: Preset[] = [
  { id: 'transcribe', icon: ListChecks, options: { targetLangs: [], insights: false, diarize: false } },
  { id: 'transcribe_translate', icon: Languages, options: { targetLangs: ['zh-CN'], insights: false, diarize: false } },
  { id: 'transcribe_insights', icon: Sparkles, options: { targetLangs: [], insights: true, diarize: false } },
  { id: 'transcribe_translate_insights', icon: Sparkles, options: { targetLangs: ['zh-CN'], insights: true, diarize: false } },
  { id: 'full', icon: UsersRound, options: { targetLangs: ['zh-CN'], insights: true, diarize: true } },
];

const languageOptions = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'ko-KR', label: '한국어' },
];

const currentPreset = computed(() => presets.find((p) => p.id === selectedPreset.value) ?? presets[2]!);
const needsTranslate = computed(() => currentPreset.value.options.targetLangs.length > 0);
const previewMessageKey = computed(() => {
  if (!preview.value) return props.videoShas.length === 0 ? 'batch.create.uploadOnStart' : 'batch.create.readyToCreate';
  if (preview.value.readyVideos > 0 && props.reusedCount > 0) return 'batch.create.libraryAndPartialReady';
  if (preview.value.readyVideos > 0) return 'batch.create.partialReady';
  if (props.reusedCount > 0) return 'batch.create.libraryReused';
  return 'batch.create.readyToCreate';
});
const previewMessageValues = computed(() => ({
  count: props.count,
  library: props.reusedCount,
  ready: preview.value?.readyVideos ?? 0,
  queued: preview.value?.queuedVideos ?? props.count,
}));
const currentOptions = computed<BatchOptions>(() => {
  const preset = currentPreset.value;
  return {
    whisperModel: whisperModel.value,
    targetLangs: preset.options.targetLangs.length > 0 ? selectedLangs.value : [],
    insights: preset.options.insights,
    insightLanguage: locale.value.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
    diarize: preset.options.diarize,
  };
});
const canStart = computed(() =>
  !(needsTranslate.value && selectedLangs.value.length === 0)
  && !previewLoading.value
  && preview.value?.allReady !== true,
);

watch(selectedPreset, () => {
  if (needsTranslate.value && selectedLangs.value.length === 0) selectedLangs.value = ['zh-CN'];
});

onMounted(async () => {
  try {
    const res = await $fetch<{ settings: { whisperModel: string } }>('/api/settings');
    whisperModel.value = res.settings.whisperModel;
  } catch {
    /* keep default */
  }
});

watch(
  () => [currentOptions.value, props.open, props.videoShas] as const,
  async ([options, isOpen, hashes]) => {
    if (!isOpen || hashes.length === 0) {
      preview.value = null;
      return;
    }
    previewLoading.value = true;
    try {
      preview.value = await $fetch<PreviewResponse>('/api/batches/preview' as string, {
        method: 'POST',
        body: { videoShas: hashes, options },
      });
    } catch {
      preview.value = null;
    } finally {
      previewLoading.value = false;
    }
  },
  { deep: true, immediate: true },
);

function toggleLang(code: string): void {
  if (selectedLangs.value.includes(code)) {
    selectedLangs.value = selectedLangs.value.filter((l) => l !== code);
  } else {
    selectedLangs.value = [...selectedLangs.value, code];
  }
}

function start(): void {
  emit('start', {
    preset: currentPreset.value.id,
    options: currentOptions.value,
  });
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <FileStack class="h-4 w-4 text-muted-foreground" />
          {{ t('batch.create.title', { count }) }}
        </DialogTitle>
        <DialogDescription class="pt-1">{{ t('batch.create.desc') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-5">
        <div class="grid gap-2 sm:grid-cols-5">
          <button
            v-for="preset in presets"
            :key="preset.id"
            type="button"
            class="flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border px-2 py-3 text-center text-xs transition-colors"
            :class="selectedPreset === preset.id
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'"
            @click="selectedPreset = preset.id"
          >
            <component :is="preset.icon" class="h-4 w-4" />
            <span>{{ t(`batch.presets.${preset.id}`) }}</span>
          </button>
        </div>

        <p class="flex min-h-10 items-center rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {{ t(`batch.presetDescriptions.${selectedPreset}`) }}
        </p>

        <div
          class="min-h-[4.75rem] rounded-md border px-3 py-3"
          :class="preview?.allReady
            ? 'border-success/35 bg-success/10 text-success'
            : 'border-border/60 bg-muted/30 text-muted-foreground'"
        >
          <div class="flex items-start gap-2">
            <CheckCircle2
              v-if="preview?.allReady"
              class="mt-0.5 h-4 w-4 shrink-0 text-success"
            />
            <Info
              v-else
              class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            />
            <div class="min-w-0">
              <div class="text-sm font-medium" :class="preview?.allReady ? 'text-success' : 'text-foreground'">
                <template v-if="preview?.allReady">{{ t('batch.create.allReadyTitle') }}</template>
                <template v-else>{{ t('batch.create.previewTitle') }}</template>
              </div>
              <p class="mt-1 text-xs leading-relaxed" :class="preview?.allReady ? 'text-success/90' : 'text-muted-foreground'">
                <template v-if="previewLoading">{{ t('batch.create.previewLoading') }}</template>
                <template v-else-if="preview?.allReady">{{ t('batch.create.allReady', { count }) }}</template>
                <template v-else>{{ t(previewMessageKey, previewMessageValues) }}</template>
              </p>
            </div>
          </div>
        </div>

        <div class="min-h-[4.5rem]">
          <div v-if="needsTranslate" class="space-y-2">
            <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {{ t('batch.create.targetLangs') }}
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="lang in languageOptions"
                :key="lang.code"
                type="button"
                class="rounded-md border px-3 py-1.5 text-xs transition-colors"
                :class="selectedLangs.includes(lang.code)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'"
                @click="toggleLang(lang.code)"
              >
                {{ lang.label }}
              </button>
            </div>
          </div>
          <div v-else class="flex min-h-[4.5rem] items-center text-xs text-muted-foreground">
            {{ t('batch.create.noTranslate') }}
          </div>
        </div>

      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">
          {{ t('common.cancel') }}
        </Button>
        <Button :disabled="!canStart" @click="start">
          <Play class="h-4 w-4" />
          {{ preview?.allReady ? t('batch.create.noWork') : t('batch.create.start') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
