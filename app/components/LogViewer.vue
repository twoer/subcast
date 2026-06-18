<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
/**
 * In-app log viewer. Wraps GET /api/diagnostics/logs (file list) and
 * GET /api/diagnostics/logs/:date?tail=N (tail content). One-shot
 * load on demand — no continuous polling, since the user is
 * troubleshooting, not monitoring.
 *
 * Lines are sanitized server-side via logSanitize.ts (path/name fields
 * → hash:xxxx) unless the user has Debug Mode on in settings.
 */
import { RefreshCw, ClipboardList, AlertTriangle } from 'lucide-vue-next';
import { Button } from '~/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { fmtBytes } from '~/utils/format';

interface LogFile {
  date: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}
interface WriterHealth {
  ok: boolean;
  consecutiveFailures: number;
  totalFailures: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}
interface LogContent {
  date: string;
  sizeBytes: number;
  lineCount: number;
  truncated: boolean;
  body: string;
}
interface ParsedLine {
  raw: string;
  level: 'info' | 'warn' | 'error' | 'debug' | 'unknown';
  ts?: number;
  event?: string;
}

const { t } = useI18n();

const TAIL_OPTIONS = [200, 500, 1000, 2000, 5000] as const;

const files = ref<LogFile[]>([]);
const filesError = ref<string | null>(null);
const filesLoading = ref(false);
const writerHealth = ref<WriterHealth | null>(null);

const selectedDate = ref<string>('');
const tailN = ref<number>(500);

const content = ref<LogContent | null>(null);
const contentError = ref<string | null>(null);
const contentLoading = ref(false);

async function loadFiles(): Promise<void> {
  filesError.value = null;
  filesLoading.value = true;
  try {
    const resp = await $fetch<{ files: LogFile[]; writerHealth: WriterHealth }>(
      '/api/diagnostics/logs',
    );
    files.value = resp.files;
    writerHealth.value = resp.writerHealth;
    if (!selectedDate.value && files.value.length > 0) {
      selectedDate.value = files.value[0]!.date;
      await loadContent();
    }
  } catch (e) {
    filesError.value = e instanceof Error ? e.message : String(e);
  } finally {
    filesLoading.value = false;
  }
}

async function loadContent(): Promise<void> {
  if (!selectedDate.value) return;
  contentError.value = null;
  contentLoading.value = true;
  try {
    content.value = await $fetch<LogContent>(
      `/api/diagnostics/logs/${selectedDate.value}`,
      { params: { tail: tailN.value } },
    );
  } catch (e) {
    const err = e as { statusMessage?: string; message?: string };
    contentError.value = err.statusMessage ?? err.message ?? t('settings.logViewer.loadFailed');
    content.value = null;
  } finally {
    contentLoading.value = false;
  }
}

const parsedLines = computed<ParsedLine[]>(() => {
  if (!content.value?.body) return [];
  const lines = content.value.body.split('\n').map<ParsedLine>((raw) => {
    try {
      const obj = JSON.parse(raw) as { level?: string; ts?: number; event?: string };
      const level: ParsedLine['level'] =
        obj.level === 'info' || obj.level === 'warn' || obj.level === 'error' || obj.level === 'debug'
          ? obj.level
          : 'unknown';
      return { raw, level, ts: obj.ts, event: obj.event };
    } catch {
      return { raw, level: 'unknown' };
    }
  });
  return lines.reverse();
});

function levelClass(l: ParsedLine['level']): string {
  if (l === 'error') return 'text-destructive';
  if (l === 'warn') return 'text-warning';
  if (l === 'debug') return 'text-muted-foreground';
  return 'text-foreground';
}

function fmtTime(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

onMounted(() => {
  void loadFiles();
});
</script>

<template>
  <section class="card space-y-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0 flex-1">
        <h2 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <ClipboardList class="h-3.5 w-3.5" />
          {{ t('settings.logViewer.title') }}
        </h2>
        <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
          {{ t('settings.logViewer.body') }}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="shrink-0 whitespace-nowrap"
        :disabled="contentLoading || filesLoading"
        @click="loadContent"
      >
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': contentLoading }" />
        {{ t('settings.logViewer.refresh') }}
      </Button>
    </div>

    <div
      v-if="writerHealth && !writerHealth.ok"
      class="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
    >
      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div class="space-y-0.5">
        <p class="font-medium">{{ t('settings.logViewer.writerUnhealthy') }}</p>
        <p class="font-mono text-2xs opacity-80">
          {{ writerHealth.consecutiveFailures }}× — {{ writerHealth.lastError }}
        </p>
      </div>
    </div>

    <div
      v-if="filesError"
      class="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
    >
      <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
      <span>{{ filesError }}</span>
    </div>

    <p
      v-else-if="!filesLoading && files.length === 0"
      class="text-sm text-muted-foreground"
    >
      {{ t('settings.logViewer.noFiles') }}
    </p>

    <template v-else-if="files.length > 0">
      <div class="flex flex-wrap items-end gap-3">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">
            {{ t('settings.logViewer.selectFile') }}
          </label>
          <Select v-model="selectedDate" @update:model-value="loadContent">
            <SelectTrigger class="h-9 w-44 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="f in files" :key="f.date" :value="f.date">
                {{ f.date }} ({{ fmtBytes(f.sizeBytes) }})
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">
            {{ t('settings.logViewer.tailLabel') }}
          </label>
          <Select
            :model-value="String(tailN)"
            @update:model-value="(v) => { tailN = Number(v); void loadContent(); }"
          >
            <SelectTrigger class="h-9 w-28 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="n in TAIL_OPTIONS" :key="n" :value="String(n)">
                {{ n }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div
        v-if="contentError"
        class="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
      >
        <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
        <span>{{ contentError }}</span>
      </div>

      <div v-else-if="content" class="space-y-2">
        <p class="text-xs text-muted-foreground">
          {{
            t('settings.logViewer.showing', {
              count: content.lineCount,
              total: parsedLines.length,
            })
          }}
          <span v-if="content.truncated"> · {{ t('settings.logViewer.truncatedNote') }}</span>
        </p>
        <div
          class="max-h-[480px] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed"
        >
          <p v-if="parsedLines.length === 0" class="text-muted-foreground">—</p>
          <div
            v-for="(line, i) in parsedLines"
            :key="i"
            class="flex gap-2 whitespace-pre-wrap break-all py-0.5"
            :class="levelClass(line.level)"
          >
            <span class="shrink-0 text-muted-foreground">{{ fmtTime(line.ts) }}</span>
            <span class="shrink-0 w-12 uppercase">{{ line.level }}</span>
            <span class="flex-1">{{ line.event ? `${line.event} — ` : '' }}{{ line.raw }}</span>
          </div>
        </div>
      </div>

      <p v-else-if="contentLoading" class="text-sm text-muted-foreground">
        {{ t('settings.logViewer.loading') }}
      </p>
    </template>
  </section>
</template>
