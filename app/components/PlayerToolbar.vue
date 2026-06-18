<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import {
  AlertCircle,
  Check,
  ChevronLeft,
  Download,
  Keyboard,
  Loader2,
  RotateCcw,
  Type,
  UsersRound,
  X as XIcon,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LangStatus } from '@/composables/useSubtitleStreams';

interface SupportedLang {
  code: string;
  label: string;
}

defineProps<{
  videoName: string;
  isTranslating: boolean;
  translateProgress: number | null;
  statusLabel: string;
  statusDotClass: string;
  cueCount: number;
  suspectCount: number;
  isDiarizing: boolean;
  speakerCount: number;
  translateRetryNotice: boolean;
  currentLang: string;
  supportedLangs: SupportedLang[];
  langStatus: Record<string, LangStatus>;
  playbackRate: number;
  speeds: readonly number[];
  canRunDiarize: boolean;
  diarizeActionFailed: boolean;
}>();

const emit = defineEmits<{
  cancelTranslation: [];
  changeLang: [value: string];
  showExport: [];
  setPlaybackRate: [value: number];
  showSettings: [];
  showHelp: [];
  runDiarize: [];
  showRetranscribe: [];
}>();

const { t } = useI18n();

function langLabel(code: string, fallbackLabel: string): string {
  return code === 'original' ? t('player.original') : fallbackLabel;
}

function onLangUpdate(value: unknown): void {
  emit('changeLang', String(value));
}

function onPlaybackRateUpdate(value: unknown): void {
  emit('setPlaybackRate', Number.parseFloat(String(value)));
}
</script>

<template>
  <div class="mb-4 flex shrink-0 flex-wrap items-start justify-between gap-3">
    <div class="flex min-w-0 flex-1 items-start gap-2">
      <Tooltip>
        <TooltipTrigger as-child>
          <NuxtLink
            to="/"
            :aria-label="t('app.back')"
            class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ChevronLeft class="h-6 w-6" />
          </NuxtLink>
        </TooltipTrigger>
        <TooltipContent>{{ t('app.back') }}</TooltipContent>
      </Tooltip>
      <span aria-hidden="true" class="mt-2 h-5 w-px shrink-0 bg-border/60" />

      <div class="flex min-w-0 flex-1 flex-col">
        <span
          v-if="videoName"
          class="truncate text-sm font-medium text-foreground"
          :title="videoName"
        >{{ videoName }}</span>

        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span
            v-if="isTranslating"
            class="inline-flex items-center gap-1.5 text-primary"
          >
            <span class="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            {{ t('player.translateProgress', { pct: translateProgress }) }}
            <span class="inline-block h-[3px] w-14 overflow-hidden rounded-full bg-border align-middle">
              <span
                class="block h-full bg-primary transition-[width]"
                :style="{ width: `${translateProgress}%` }"
              />
            </span>
            <button
              type="button"
              class="underline underline-offset-2 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
              @click="emit('cancelTranslation')"
            >{{ t('player.cancel') }}</button>
          </span>
          <span
            v-else-if="statusLabel"
            class="inline-flex items-center gap-1.5"
          >
            <span class="inline-block h-1.5 w-1.5 rounded-full" :class="statusDotClass" />
            {{ statusLabel }}
          </span>

          <span v-if="cueCount > 0">{{ t('player.cues', { n: cueCount }) }}</span>

          <span v-if="suspectCount > 0" class="text-warning-foreground dark:text-warning">
            {{ t('player.suspect', { n: suspectCount }) }}
          </span>

          <span v-if="isDiarizing" class="inline-flex items-center gap-1">
            <Loader2 class="h-3 w-3 animate-spin" />
            {{ t('player.diarize.diarizing') }}
          </span>
          <span v-else-if="speakerCount === 1" class="inline-flex items-center gap-1">
            <UsersRound class="h-3 w-3" />
            {{ t('player.diarize.singleSpeakerBadge') }}
          </span>
          <span v-else-if="speakerCount >= 2" class="inline-flex items-center gap-1">
            <UsersRound class="h-3 w-3" />
            {{ t('player.diarize.doneBadge', { n: speakerCount }) }}
          </span>

          <span
            v-if="translateRetryNotice && currentLang !== 'original'"
            class="text-warning-foreground dark:text-warning"
          >{{ t('player.translateRetrying') }}</span>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <Select
        :model-value="currentLang"
        @update:model-value="onLangUpdate"
      >
        <SelectTrigger class="h-8 w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="l in supportedLangs" :key="l.code" :value="l.code">
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

      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="outline"
            size="icon-sm"
            class="size-8 [&_svg]:size-3.5"
            :aria-label="t('player.export.title')"
            @click="emit('showExport')"
          >
            <Download />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t('player.export.title') }}</TooltipContent>
      </Tooltip>

      <Select
        :model-value="String(playbackRate)"
        @update:model-value="onPlaybackRateUpdate"
      >
        <SelectTrigger class="h-8 w-[72px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="s in speeds" :key="s" :value="String(s)">{{ s }}x</SelectItem>
        </SelectContent>
      </Select>

      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="outline"
            size="icon-sm"
            class="size-8 [&_svg]:size-3.5"
            :aria-label="t('player.subtitleStyle')"
            @click="emit('showSettings')"
          >
            <Type />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t('player.subtitleStyle') }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="outline"
            size="icon-sm"
            class="size-8 [&_svg]:size-3.5"
            :aria-label="t('player.shortcuts')"
            @click="emit('showHelp')"
          >
            <Keyboard />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t('player.shortcuts') }} (?)</TooltipContent>
      </Tooltip>

      <span
        v-if="canRunDiarize"
        aria-hidden="true"
        class="mx-1 h-5 w-px bg-border/60"
      />
      <Tooltip
        v-if="canRunDiarize"
      >
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="utility"
            :class="diarizeActionFailed
              ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
            @click="emit('runDiarize')"
          >
            <AlertCircle v-if="diarizeActionFailed" />
            <UsersRound v-else />
            {{ diarizeActionFailed
              ? t('player.diarize.retryButton')
              : t('player.diarize.runButton') }}
          </Button>
        </TooltipTrigger>
        <TooltipContent class="max-w-xs">
          {{ t('player.diarize.runHint') }}
        </TooltipContent>
      </Tooltip>

      <span
        v-if="cueCount > 0"
        aria-hidden="true"
        class="mx-1 h-5 w-px bg-border/60"
      />
      <Button
        v-if="cueCount > 0"
        variant="ghost"
        size="utility"
        class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        @click="emit('showRetranscribe')"
      >
        <RotateCcw />
        {{ t('player.retranscribe.button') }}
      </Button>
    </div>
  </div>
</template>
