<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { MoreHorizontal, Check, Pencil } from 'lucide-vue-next';
import { PopoverRoot, PopoverTrigger, PopoverContent, PopoverPortal, PopoverClose } from 'reka-ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Button } from '~/components/ui/button';
import SpeakerChip from './SpeakerChip.vue';
import type { SpeakerId } from '#shared/diarization';

/**
 * Sticky block header used in the grouped subtitle view. Shows the
 * speaker's color dot + display name (or i18n default) + percentage of
 * total speech time + ⋯ menu (Q9d).
 *
 * Menu actions (R15: K change lives here, not on the toggle button):
 *   - Rename — opens a Dialog (matches the library page's rename UX,
 *     including IME-safe Enter handling for Chinese pinyin input)
 *   - Change speaker count (1/2/3/4/Auto) → reconsolidate
 *
 * Click the name itself = open rename dialog (same as menu item).
 */

const props = defineProps<{
  speakerId: SpeakerId;
  /** Stable color index from speakerColorIndex(). */
  colorIndex: number;
  displayName: string | null;
  /** Speaker's share of total speech (0..1) for the small caption. */
  ratio: number;
  /** Speaker's duration in seconds for the small caption. */
  durationS: number;
  /** Current K — controls which menu item shows ✓. */
  currentTopK: number;
  /** Available K options shown in the change-K submenu. */
  topKOptions?: number[];
}>();

const emit = defineEmits<{
  rename: [speakerId: SpeakerId, displayName: string | null];
  changeTopK: [topK: number];
}>();

const { t } = useI18n();

const renameOpen = ref(false);
const renameValue = ref('');
const renameSaving = ref(false);
const renameInputRef = ref<HTMLInputElement | null>(null);

const isUnknown = computed(() => props.speakerId === 'unknown');

/** Short letter from 'speaker_A' → 'A'. */
const shortLabel = computed(() => {
  if (isUnknown.value) return '?';
  const m = props.speakerId.match(/^speaker_([A-Z]{1,2})$/);
  return m ? m[1] : props.speakerId;
});

const longName = computed(() => {
  if (isUnknown.value) return t('player.diarize.unknownSpeaker');
  return props.displayName || t('player.diarize.speakerDefault', { letter: shortLabel.value });
});

const hslHue = computed(() => (isUnknown.value ? null : (props.colorIndex * 137) % 360));

// Border-left and bg tint share the same hue formula as SpeakerChip and
// the list-view cue thread (hash.vue's speakerThreadColor). 0.5 alpha on
// the border matches the thread span so the header reads as the "head"
// of the same colored spine that runs through the grouped cues below.
const headerBgStyle = computed(() => {
  if (isUnknown.value) {
    return {
      borderLeftColor: 'hsl(215 16% 60% / 0.5)',
      background: 'hsl(215 16% 60% / 0.06)',
    };
  }
  return {
    borderLeftColor: `hsl(${hslHue.value} 75% 55% / 0.5)`,
    background: `hsl(${hslHue.value} 75% 55% / 0.06)`,
  };
});

const captionParts = computed(() => {
  const pct = `${(props.ratio * 100).toFixed(1)}%`;
  const total = Math.round(props.durationS);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const dur = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s} s`;
  return `${pct} · ${dur}`;
});

const options = computed(() => props.topKOptions ?? [1, 2, 3, 4]);

function openRename(): void {
  if (isUnknown.value) return;
  renameValue.value = props.displayName ?? '';
  renameSaving.value = false;
  renameOpen.value = true;
  nextTick(() => {
    const el = renameInputRef.value;
    if (el) {
      el.focus();
      el.select();
    }
  });
}

// IME composition (e.g. Chinese pinyin) commits the in-progress
// character on Enter. Guard against running confirmRename before
// v-model receives the committed character. Pattern mirrors
// library.vue's onRenameEnter — `isComposing` is the W3C signal;
// keyCode === 229 is the older fallback some browsers use during
// IME composition.
function onRenameEnter(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  void confirmRename();
}

async function confirmRename(): Promise<void> {
  if (!renameOpen.value || renameSaving.value) return;
  renameSaving.value = true;
  const trimmed = renameValue.value.trim();
  emit('rename', props.speakerId, trimmed.length > 0 ? trimmed : null);
  renameOpen.value = false;
}
</script>

<template>
  <div
    class="group/header sticky top-0 z-10 flex items-center justify-between gap-2 border-l-2 px-3 py-1.5"
    :class="isUnknown ? 'border-dashed opacity-80' : ''"
    :style="headerBgStyle"
  >
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <SpeakerChip
        :speaker-id="speakerId"
        :color-index="colorIndex"
        :display-name="displayName"
      />
      <button
        type="button"
        class="truncate text-left text-sm font-semibold hover:underline"
        :disabled="isUnknown"
        :title="isUnknown ? '' : t('player.diarize.clickToRename')"
        @click="openRename"
      >
        {{ longName }}
      </button>
      <span class="ml-1 font-mono text-2xs text-muted-foreground">{{ captionParts }}</span>
    </div>

    <PopoverRoot v-if="!isUnknown">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100 data-[state=open]:opacity-100"
          :aria-label="t('player.diarize.headerMenu')"
        >
          <MoreHorizontal class="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          align="end"
          :side-offset="4"
          class="z-50 min-w-[13rem] rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          <PopoverClose
            v-if="!isUnknown"
            as-child
          >
            <button
              type="button"
              class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-accent"
              @click="openRename"
            >
              <Pencil class="h-4 w-4 text-muted-foreground" />
              <span class="flex-1 text-left">{{ t('player.diarize.rename') }}</span>
            </button>
          </PopoverClose>

          <div class="mx-1 my-1.5 border-t border-border/60"/>
          <div class="px-2.5 pt-1.5 pb-1 text-3xs font-medium uppercase tracking-wider text-foreground/50">
            {{ t('player.diarize.changeTopK') }}
          </div>
          <PopoverClose
            v-for="opt in options"
            :key="opt"
            as-child
          >
            <button
              type="button"
              class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-accent"
              @click="emit('changeTopK', opt)"
            >
              <span class="flex-1 text-left">{{ t('player.diarize.topKOption', { k: opt }) }}</span>
              <span class="grid w-4 place-items-center">
                <Check v-if="opt === currentTopK" class="h-3.5 w-3.5" />
              </span>
            </button>
          </PopoverClose>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>

  <Dialog
    :open="renameOpen"
    @update:open="(v: boolean) => { if (!v) renameOpen = false }"
  >
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Pencil class="h-4 w-4 text-muted-foreground" />
          {{ t('player.diarize.renameDialogTitle', { current: longName }) }}
        </DialogTitle>
        <DialogDescription>
          {{ t('player.diarize.renameDialogDesc') }}
        </DialogDescription>
      </DialogHeader>
      <input
        ref="renameInputRef"
        v-model="renameValue"
        type="text"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        class="flex h-11 w-full rounded-lg border border-input bg-background px-3.5 text-sm transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
        :placeholder="t('player.diarize.renamePlaceholder', { letter: shortLabel })"
        @keydown.enter="onRenameEnter"
      >
      <DialogFooter>
        <span class="hidden flex-1 text-xs text-muted-foreground sm:inline-flex sm:items-center sm:gap-1">
          <kbd class="rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
          {{ t('player.diarize.renameConfirm') }}
          <span class="mx-1 text-border">·</span>
          <kbd class="rounded border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>
          {{ t('player.diarize.renameCancel') }}
        </span>
        <Button variant="ghost" @click="renameOpen = false">
          {{ t('player.diarize.renameCancel') }}
        </Button>
        <Button :disabled="renameSaving" @click="confirmRename">
          {{ t('player.diarize.renameConfirm') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
