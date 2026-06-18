<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { Sparkles, Play, RotateCcw, X as XIcon, AlertCircle, Check, Trash2, Languages, Copy } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { useClipboardFeedback } from '@/composables/useClipboardFeedback';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface Chapter { startMs: number; title: string; description: string }
interface Insights {
  summary: string;
  summaryBullets: string[];
  chapters: Chapter[];
  _meta?: { ollamaModel: string; uiLanguage: string; originalCueCount: number; generatedAt: number };
}

const props = defineProps<{
  hash: string;
  cueCount: number;
  transcriptReady: boolean;
  currentLlmModel: string;
}>();

const emit = defineEmits<{
  (e: 'seek', ms: number): void;
}>();

type State = 'empty' | 'generating' | 'ready' | 'outdated' | 'error';

const { t, locale } = useI18n();
const state = ref<State>('empty');
const errorCode = ref<string | null>(null);
const streamedText = ref<string>('');
const insights = ref<Insights | null>(null);
let es: EventSource | null = null;
let currentTaskId: string | null = null;

// v0.1 cached `_meta.ollamaModel` as the full Ollama name (`qwen2.5:7b`),
// v0.2+ stores the tier id (`7b` / `3b` / `14b`). Normalize before
// comparing so old insights don't show a permanent "outdated" warning
// just because the naming convention changed.
function toTier(s: string): string {
  const m = /^qwen2\.5:(3b|7b|14b)$/i.exec(s);
  return m ? m[1]!.toLowerCase() : s;
}

const isOutdated = computed(() => {
  const m = insights.value?._meta;
  if (!m) return false;
  return toTier(m.ollamaModel) !== toTier(props.currentLlmModel)
    || m.originalCueCount !== props.cueCount;
});

// Normalize between server tag ('zh-CN' / 'en') and Nuxt i18n locale ('zh' / 'en').
function normalizeLang(code: string): 'zh' | 'en' {
  return code.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const insightLang = computed<'zh' | 'en' | null>(() => {
  const m = insights.value?._meta;
  return m ? normalizeLang(m.uiLanguage) : null;
});

const currentLang = computed<'zh' | 'en'>(() => normalizeLang(locale.value));

const langMismatch = computed(() =>
  insightLang.value !== null && insightLang.value !== currentLang.value,
);

const langLabel = (code: 'zh' | 'en'): string =>
  code === 'zh' ? t('player.insights.langZh') : t('player.insights.langEn');

onMounted(() => {
  fetchInitial();
});

onBeforeUnmount(() => {
  closeStream();
});

async function fetchInitial() {
  try {
    const res = await $fetch<{ items: Array<{ sha256: string; hasInsights?: boolean; hasRunningInsight?: boolean }> }>('/api/cache/list');
    const entry = res.items.find((i) => i.sha256 === props.hash);
    if (entry?.hasRunningInsight) {
      // Reattach to an in-flight task started from a prior visit / page reload.
      startStream();
    } else if (entry?.hasInsights) {
      startStream(true);
    }
  } catch {
    // ignore
  }
}

function startStream(silent = false) {
  if (!props.transcriptReady) {
    state.value = 'empty';
    errorCode.value = null;
    return;
  }
  closeStream();
  if (!silent) {
    state.value = 'generating';
    streamedText.value = '';
    errorCode.value = null;
  }
  es = new EventSource(`/api/insights?hash=${encodeURIComponent(props.hash)}`);
  es.addEventListener('start', (e) => {
    if (!silent) state.value = 'generating';
    const data = JSON.parse((e as MessageEvent).data);
    currentTaskId = data.taskId;
  });
  es.addEventListener('token', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    streamedText.value += data.text;
  });
  es.addEventListener('done', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    insights.value = data.insights;
    state.value = isOutdated.value ? 'outdated' : 'ready';
    closeStream();
  });
  es.addEventListener('error', (e) => {
    if (es?.readyState === EventSource.CLOSED) return;
    let data: { code?: string } = { code: 'NETWORK' };
    try {
      const md = (e as MessageEvent).data;
      if (md) data = JSON.parse(md);
    } catch { /* keep default */ }
    errorCode.value = data.code ?? 'NETWORK';
    state.value = 'error';
    closeStream();
  });
}

function closeStream() {
  if (es) {
    es.close();
    es = null;
  }
}

async function cancel() {
  if (currentTaskId) {
    try {
      await $fetch(`/api/insights/${currentTaskId}`, { method: 'DELETE' });
    } catch {
      // ignore
    }
  }
  closeStream();
  state.value = 'empty';
  streamedText.value = '';
  currentTaskId = null;
}

function regenerate() {
  insights.value = null;
  startStream();
}

const { copiedKey, copy: copyToClipboard } = useClipboardFeedback<'summary'>();
const justCopied = computed(() => copiedKey.value === 'summary');

function fmtTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function copySummary(): Promise<void> {
  if (!insights.value) return;
  const i = insights.value;
  const parts: string[] = [];
  if (i.summary) parts.push(`## ${t('player.insights.summarySection')}\n\n${i.summary}`);
  if (i.summaryBullets.length > 0) {
    parts.push(i.summaryBullets.map((b) => `- ${b}`).join('\n'));
  }
  if (i.chapters.length > 0) {
    parts.push(
      `## ${t('player.insights.chaptersSection')}\n\n`
      + i.chapters
        .map((c) => `- [${fmtTimestamp(c.startMs)}] ${c.title}${c.description ? ` — ${c.description}` : ''}`)
        .join('\n'),
    );
  }
  const text = parts.join('\n\n');
  await copyToClipboard('summary', text);
}

const showClearDialog = ref(false);

async function confirmClear() {
  showClearDialog.value = false;
  try {
    await $fetch(`/api/insights?hash=${encodeURIComponent(props.hash)}`, { method: 'DELETE' });
  } catch {
    // ignore — local reset still useful even if server delete fails
  }
  insights.value = null;
  streamedText.value = '';
  state.value = 'empty';
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('index.library.justNow');
  if (diff < 3_600_000) return t('index.library.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('index.library.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  return t('index.library.daysAgo', { n: Math.floor(diff / 86_400_000) });
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const elapsedSeconds = ref(0);
let elapsedInterval: ReturnType<typeof setInterval> | null = null;

watch(state, (s) => {
  if (s === 'generating') {
    elapsedSeconds.value = 0;
    if (elapsedInterval) clearInterval(elapsedInterval);
    elapsedInterval = setInterval(() => { elapsedSeconds.value++; }, 1000);
  } else if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
});

const SUMMARY_RE = /## Summary\s*\n([\s\S]*?)(?=\n## |$)/i;
const CHAPTERS_RE = /## Chapters\s*\n([\s\S]*?)$/i;
const CHAPTER_LINE_RE = /^[-*]\s+\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)(?:\s*[–\-—→~]\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?\]?\s*[:：]?\s*(.+?)(?:\s+[—–-]\s+(.+))?$/;

function tsToMs(ts: string): number {
  const clean = ts.replace(/\.\d+$/, '');
  const parts = clean.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 3) return parts[0]! * 3_600_000 + parts[1]! * 60_000 + parts[2]! * 1000;
  return parts[0]! * 60_000 + parts[1]! * 1000;
}

const streamingInsights = computed(() => {
  if (!streamedText.value) {
    return { summary: '', summaryBullets: [] as string[], chapters: [] as Chapter[], hasSummaryHeading: false, hasChaptersHeading: false };
  }
  const md = streamedText.value;
  const hasSummaryHeading = /## Summary/i.test(md);
  const hasChaptersHeading = /## Chapters/i.test(md);

  let summary = '';
  const summaryBullets: string[] = [];
  const sumMatch = SUMMARY_RE.exec(md);
  if (sumMatch) {
    const block = sumMatch[1]!.trim();
    const lines = block.split('\n');
    const paraLines: string[] = [];
    let inBullets = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        inBullets = true;
        summaryBullets.push(trimmed.slice(2).trim());
      } else if (!inBullets && trimmed) {
        paraLines.push(trimmed);
      }
    }
    summary = paraLines.join(' ').trim();
  }

  const chapters: Chapter[] = [];
  const chMatch = CHAPTERS_RE.exec(md);
  if (chMatch) {
    for (const line of chMatch[1]!.split('\n')) {
      const m = CHAPTER_LINE_RE.exec(line.trim());
      if (!m) continue;
      try {
        chapters.push({ startMs: tsToMs(m[1]!), title: m[2]!.trim(), description: (m[3] ?? '').trim() });
      } catch { /* skip */ }
    }
  }
  return { summary, summaryBullets, chapters, hasSummaryHeading, hasChaptersHeading };
});

const generatingLabel = computed(() => {
  if (streamingInsights.value.hasChaptersHeading) return t('player.insights.generatingChapters');
  if (streamingInsights.value.hasSummaryHeading) return t('player.insights.generatingSummary');
  return t('player.insights.generatingReading');
});
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <!-- empty -->
    <div v-if="state === 'empty'" class="flex flex-1 flex-col items-center justify-center px-6">
      <div class="flex w-full max-w-[18rem] flex-col items-center gap-5 text-center">
        <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 text-primary shadow-sm ring-1 ring-primary/20">
          <Sparkles class="h-7 w-7" />
        </div>
        <div class="space-y-1.5">
          <h3 class="text-lg font-semibold text-foreground">{{ t('player.insights.emptyTitle') }}</h3>
          <p class="text-sm text-muted-foreground">{{ t('player.insights.emptyHint') }}</p>
        </div>
        <ul class="w-full space-y-1.5 text-sm text-muted-foreground">
          <li class="flex items-center justify-center gap-2">
            <Check class="h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{{ t('player.insights.feature1') }}</span>
          </li>
          <li class="flex items-center justify-center gap-2">
            <Check class="h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{{ t('player.insights.feature2') }}</span>
          </li>
          <li class="flex items-center justify-center gap-2">
            <Check class="h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{{ t('player.insights.feature3') }}</span>
          </li>
        </ul>
        <Button :disabled="!transcriptReady" @click="startStream()">
          <Sparkles class="mr-1.5 h-4 w-4" />
          {{ t('player.insights.generate') }}
        </Button>
        <p class="text-xs text-muted-foreground/70">
          {{ transcriptReady ? t('player.insights.estimate', { model: currentLlmModel }) : t('player.insights.waitForTranscript') }}
        </p>
      </div>
    </div>

    <!-- generating: skeleton + progressive fill matching the ready layout -->
    <div v-else-if="state === 'generating'" class="flex flex-1 flex-col min-h-0">
      <!-- status header (fixed) -->
      <div class="shrink-0 flex items-center gap-2 px-1 pb-3 text-sm">
        <span class="relative flex h-2 w-2 shrink-0">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/50" />
          <span class="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span class="font-medium text-foreground">{{ generatingLabel }}</span>
        <span class="shrink-0 tabular-nums text-xs text-muted-foreground">{{ elapsedSeconds }}s</span>
      </div>
      <!-- scrollable body -->
      <div class="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-3 pr-3">

      <!-- summary section -->
      <section>
        <h3 class="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('player.insights.summarySection') }}</h3>
        <template v-if="streamingInsights.summary || streamingInsights.summaryBullets.length > 0">
          <p v-if="streamingInsights.summary" class="text-sm leading-relaxed">{{ streamingInsights.summary }}<span v-if="!streamingInsights.hasChaptersHeading" class="ml-0.5 inline-block animate-pulse text-primary">▍</span></p>
          <ul v-if="streamingInsights.summaryBullets.length > 0" class="space-y-1.5 text-sm text-muted-foreground" :class="streamingInsights.summary ? 'mt-3' : ''">
            <li v-for="(b, i) in streamingInsights.summaryBullets" :key="i" class="flex gap-2">
              <span class="text-muted-foreground">•</span>
              <span>{{ b }}</span>
            </li>
          </ul>
        </template>
        <div v-else class="space-y-2">
          <div class="h-3 w-full animate-pulse rounded bg-muted" />
          <div class="h-3 w-11/12 animate-pulse rounded bg-muted" />
          <div class="h-3 w-4/5 animate-pulse rounded bg-muted" />
          <div class="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </section>

      <!-- chapters section -->
      <section>
        <h3 class="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('player.insights.chaptersSection') }}</h3>
        <ul v-if="streamingInsights.chapters.length > 0" class="space-y-2">
          <li v-for="(ch, i) in streamingInsights.chapters" :key="i" class="rounded-md border border-border/40 bg-muted/20 p-2.5">
            <div class="flex items-baseline gap-2">
              <span class="shrink-0 font-mono text-xs tabular-nums text-primary">{{ fmtTime(ch.startMs) }}</span>
              <span class="text-sm font-medium">{{ ch.title }}</span>
            </div>
            <p v-if="ch.description" class="mt-1 text-xs text-muted-foreground">{{ ch.description }}</p>
          </li>
        </ul>
        <div v-else class="space-y-3">
          <div class="space-y-1.5">
            <div class="h-3 w-1/4 animate-pulse rounded bg-muted" />
            <div class="h-3 w-4/5 animate-pulse rounded bg-muted" />
          </div>
          <div class="space-y-1.5">
            <div class="h-3 w-1/4 animate-pulse rounded bg-muted" />
            <div class="h-3 w-3/4 animate-pulse rounded bg-muted" />
          </div>
          <div class="space-y-1.5">
            <div class="h-3 w-1/4 animate-pulse rounded bg-muted" />
            <div class="h-3 w-5/6 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </section>
      </div>

      <!-- sticky footer: cancel (mirrors ready-state footer with regenerate/clear) -->
      <div class="shrink-0 flex items-center justify-between gap-2 border-t border-border/40 px-1 pt-3 text-xs text-muted-foreground">
        <span class="min-w-0 truncate">{{ currentLlmModel }}</span>
        <Button size="sm" variant="outline" @click="cancel">
          <XIcon class="mr-1 h-3.5 w-3.5" />
          {{ t('player.insights.cancel') }}
        </Button>
      </div>
    </div>

    <!-- ready / outdated -->
    <div v-else-if="(state === 'ready' || state === 'outdated') && insights" class="flex flex-1 flex-col min-h-0">
      <!-- scrollable body -->
      <div class="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-3 pr-3">
        <div v-if="state === 'outdated'" class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertCircle class="h-4 w-4 shrink-0 text-warning" />
          <div class="flex-1">{{ t('player.insights.outdatedHint') }}</div>
          <Button size="sm" variant="ghost" @click="regenerate">
            <RotateCcw class="mr-1 h-3.5 w-3.5" />
            {{ t('player.insights.regenerate') }}
          </Button>
        </div>

        <div
          v-if="langMismatch && insightLang"
          class="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm"
        >
          <Languages class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div class="flex-1 text-muted-foreground">
            {{ t('player.insights.langMismatch', { lang: langLabel(insightLang) }) }}
          </div>
          <Button size="xs" variant="outline" @click="regenerate">
            <RotateCcw />
            {{ t('player.insights.regenerateInLang', { lang: langLabel(currentLang) }) }}
          </Button>
        </div>

        <section>
          <h3 class="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('player.insights.summarySection') }}</h3>
          <p v-if="insights.summary" class="text-sm leading-relaxed">{{ insights.summary }}</p>
          <ul v-if="insights.summaryBullets.length > 0" class="space-y-1.5 text-sm text-muted-foreground" :class="insights.summary ? 'mt-3' : ''">
            <li v-for="(b, i) in insights.summaryBullets" :key="i" class="flex gap-2">
              <span class="text-muted-foreground">•</span>
              <span>{{ b }}</span>
            </li>
          </ul>
        </section>

        <section v-if="insights.chapters.length > 0">
          <h3 class="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('player.insights.chaptersSection') }}</h3>
          <ul class="space-y-2">
            <li
              v-for="(ch, i) in insights.chapters"
              :key="i"
              class="cursor-pointer rounded-md border border-border/40 bg-muted/20 p-2.5 hover:bg-accent"
              @click="emit('seek', ch.startMs)"
            >
              <div class="flex items-baseline gap-2">
                <span class="shrink-0 font-mono text-xs tabular-nums text-primary">{{ fmtTime(ch.startMs) }}</span>
                <span class="text-sm font-medium">{{ ch.title }}</span>
              </div>
              <p v-if="ch.description" class="mt-1 text-xs text-muted-foreground">{{ ch.description }}</p>
            </li>
          </ul>
        </section>
      </div>

      <!-- sticky footer -->
      <div class="shrink-0 flex items-center justify-between gap-2 border-t border-border/40 px-1 pt-3 text-xs text-muted-foreground">
        <span class="min-w-0 truncate">
          {{ insights._meta?.ollamaModel ?? currentLlmModel }} ·
          {{ relativeTime(insights._meta?.generatedAt ?? Date.now()) }}
          <span v-if="insightLang"> · {{ langLabel(insightLang) }}</span>
        </span>
        <div class="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" @click="copySummary">
            <Check v-if="justCopied" />
            <Copy v-else />
            {{ justCopied ? t('player.insights.copied') : t('player.insights.copy') }}
          </Button>
          <Button size="xs" variant="ghost" @click="regenerate">
            <RotateCcw />
            {{ t('player.insights.regenerate') }}
          </Button>
          <Button size="xs" variant="ghost" class="text-destructive hover:bg-destructive/10 hover:text-destructive" @click="showClearDialog = true">
            <Trash2 />
            {{ t('player.insights.clear') }}
          </Button>
        </div>
      </div>
    </div>

    <!-- error -->
    <div v-else-if="state === 'error'" class="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-destructive/15 to-destructive/5 text-destructive shadow-sm ring-1 ring-destructive/20">
        <AlertCircle class="h-7 w-7" />
      </div>
      <p class="text-sm text-muted-foreground">{{ t(`player.insights.errors.${errorCode}`, t('player.insights.errors.fallback')) }}</p>
      <Button :disabled="!transcriptReady" @click="startStream()">
        <Play class="mr-1.5 h-4 w-4" />
        {{ t('player.insights.retry') }}
      </Button>
    </div>

    <Dialog v-model:open="showClearDialog">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('player.insights.clearTitle') }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ t('player.insights.clearDesc') }}</p>
        <DialogFooter>
          <Button variant="ghost" @click="showClearDialog = false">{{ t('common.cancel') }}</Button>
          <Button variant="destructive" @click="confirmClear">{{ t('player.insights.clearConfirm') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
