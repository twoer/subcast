<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Download } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Format = 'vtt' | 'srt' | 'txt' | 'bilingual-vtt' | 'bilingual-srt';

const props = defineProps<{
  modelValue: boolean;
  hash: string;
  cachedLangs: string[];
  langLabel: (code: string) => string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const { t } = useI18n();

const selected = ref<Set<string>>(new Set());
const format = ref<Format>('vtt');

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      selected.value = new Set(props.cachedLangs);
      format.value = 'vtt';
    }
  },
);

const isBilingual = computed(() => format.value.startsWith('bilingual-'));

const canDownload = computed(() => {
  const n = selected.value.size;
  return isBilingual.value ? n === 2 : n >= 1;
});

const hint = computed(() => {
  if (selected.value.size === 0) return t('player.export.hintAtLeastOne');
  if (isBilingual.value && selected.value.size !== 2) return t('player.export.hintExactly2');
  return '';
});

function toggle(lang: string) {
  const s = new Set(selected.value);
  if (s.has(lang)) s.delete(lang);
  else s.add(lang);
  selected.value = s;
}

function close() {
  emit('update:modelValue', false);
}

// Speaker-label flag: include "<v Speaker A>" / "Speaker A:" prefix in
// the exported subtitle when diarize result is available. Default ON
// for monolingual formats; bilingual ignores this (Q4 + §六 decision:
// bilingual exports the dominant speaker only, never splits the cue).
const includeSpeakers = ref(true);

function download() {
  if (!canDownload.value) return;
  const langs = Array.from(selected.value).join(',');
  const params = new URLSearchParams({
    hash: props.hash,
    langs,
    format: format.value,
  });
  if (includeSpeakers.value) params.set('speakers', '1');
  window.open(`/api/export?${params.toString()}`, '_self');
  close();
}
</script>

<template>
  <Dialog :open="modelValue" @update:open="emit('update:modelValue', $event)">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Download class="h-4 w-4 text-muted-foreground" />
          {{ t('player.export.title') }}
        </DialogTitle>
      </DialogHeader>
      <div class="space-y-5">
        <div>
          <div class="mb-2 text-sm font-medium">{{ t('player.export.languages') }}</div>
          <ul class="space-y-1.5 max-h-48 overflow-y-auto">
            <li v-for="lang in cachedLangs" :key="lang" class="flex items-center gap-2">
              <input
                :id="`exp-lang-${lang}`"
                type="checkbox"
                :checked="selected.has(lang)"
                @change="toggle(lang)"
              >
              <label :for="`exp-lang-${lang}`" class="cursor-pointer text-sm">
                {{ langLabel(lang) }}
              </label>
            </li>
          </ul>
        </div>
        <div>
          <div class="mb-2 text-sm font-medium">{{ t('player.export.format') }}</div>
          <Select v-model="format">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="vtt">VTT</SelectItem>
              <SelectItem value="srt">SRT</SelectItem>
              <SelectItem value="txt">TXT</SelectItem>
              <SelectItem value="bilingual-vtt">Bilingual VTT</SelectItem>
              <SelectItem value="bilingual-srt">Bilingual SRT</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-2">
          <input
            id="exp-speakers"
            v-model="includeSpeakers"
            type="checkbox"
          >
          <label for="exp-speakers" class="cursor-pointer text-sm">
            {{ t('player.export.includeSpeakers') }}
          </label>
        </div>
        <p v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="close">{{ t('common.cancel') }}</Button>
        <Button :disabled="!canDownload" @click="download">
          <Download class="h-4 w-4" />
          {{ t('player.export.download') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
