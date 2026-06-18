<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle, Check, Keyboard, Palette, RotateCcw, Type, X as XIcon } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Shortcut {
  keys: string;
  descKey: string;
}

interface ColorPreset {
  label: string;
  value: string;
}

interface SubtitleStyleState {
  fontSize: number;
  color: string;
  bgOpacity: number;
}

const props = defineProps<{
  shortcuts: Shortcut[];
  retranscribedLangCount: number;
  retranscribing: boolean;
  subtitleStyle: SubtitleStyleState;
  isCustomColor: boolean;
  colorPresets: readonly ColorPreset[];
}>();

const emit = defineEmits<{
  updateSubtitleFontSize: [value: number];
  updateSubtitleColor: [value: string];
  updateSubtitleBgOpacity: [value: number];
  cancelTranslation: [];
  confirmRetranscribe: [];
  resetSubtitleStyle: [];
}>();

const { t } = useI18n();

// The four dialog visibility flags are genuinely shared with the parent:
// showHelp/showSettings are toggled by usePlayerKeybindings (? / Escape),
// showRetranscribeDialog is owned by useRetranscribeAction, and
// showCancelDialog by useLangSwitcher. defineModel keeps the v-model
// contract the parent already uses (v-model:show-*) without the hand-written
// computed proxies + update:showX emits we'd otherwise need.
const showHelp = defineModel<boolean>('showHelp', { required: true });
const showCancelDialog = defineModel<boolean>('showCancelDialog', { required: true });
const showRetranscribeDialog = defineModel<boolean>('showRetranscribeDialog', { required: true });
const showSettings = defineModel<boolean>('showSettings', { required: true });

const subtitleFontSizeProxy = computed({
  get: () => props.subtitleStyle.fontSize,
  set: (value: number) => emit('updateSubtitleFontSize', value),
});
const subtitleColorProxy = computed({
  get: () => props.subtitleStyle.color,
  set: (value: string) => emit('updateSubtitleColor', value),
});
const subtitleBgOpacityProxy = computed({
  get: () => props.subtitleStyle.bgOpacity,
  set: (value: number) => emit('updateSubtitleBgOpacity', value),
});
</script>

<template>
  <div>
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
              v-for="s in shortcuts"
              :key="s.keys"
              class="border-b border-border/30 transition-colors last:border-0 hover:bg-muted/40"
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
          <Button variant="ghost" @click="showCancelDialog = false">
            {{ t('player.cancel') }}
          </Button>
          <Button variant="destructive" @click="emit('cancelTranslation')">
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
          <Button variant="ghost" :disabled="retranscribing" @click="showRetranscribeDialog = false">
            {{ t('player.cancel') }}
          </Button>
          <Button variant="destructive" :disabled="retranscribing" @click="emit('confirmRetranscribe')">
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
              <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ subtitleStyle.fontSize.toFixed(2) }}em</span>
            </Label>
            <input
              v-model.number="subtitleFontSizeProxy"
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
              <Tooltip v-for="p in colorPresets" :key="p.value">
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    :aria-label="p.label"
                    :aria-pressed="subtitleStyle.color.toLowerCase() === p.value.toLowerCase()"
                    class="relative grid size-7 place-items-center rounded-full border border-border/60 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
                    :style="{ backgroundColor: p.value }"
                    @click="subtitleColorProxy = p.value"
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
                  <label
                    :aria-label="t('player.customColor')"
                    :aria-pressed="isCustomColor"
                    class="relative grid size-7 cursor-pointer place-items-center rounded-full border border-border/60 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
                    :style="isCustomColor
                      ? { backgroundColor: subtitleStyle.color }
                      : { background: 'conic-gradient(from 90deg, #ef4444, #facc15, #4ade80, #22d3ee, #818cf8, #f472b6, #ef4444)' }"
                  >
                    <Palette
                      v-if="!isCustomColor"
                      class="h-3.5 w-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]"
                    />
                    <Check v-else class="h-3.5 w-3.5 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" />
                    <input
                      v-model="subtitleColorProxy"
                      type="color"
                      class="sr-only"
                      tabindex="-1"
                      aria-hidden="true"
                    >
                  </label>
                </TooltipTrigger>
                <TooltipContent>{{ t('player.customColor') }}</TooltipContent>
              </Tooltip>
              <span class="ml-1 font-mono text-xs uppercase tabular-nums text-muted-foreground">{{ subtitleStyle.color }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <Label class="flex items-center justify-between text-sm font-medium">
              <span>{{ t('player.bgOpacity') }}</span>
              <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ Math.round(subtitleStyle.bgOpacity * 100) }}%</span>
            </Label>
            <input
              v-model.number="subtitleBgOpacityProxy"
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
              @click="emit('resetSubtitleStyle')"
            >
              <RotateCcw class="h-3.5 w-3.5" />
              {{ t('player.reset') }}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
