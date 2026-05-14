<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { Trash2, AlertTriangle, Database, Pencil } from 'lucide-vue-next';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { getFileStatus, type QueueItemLike } from '~/utils/fileStatus';

interface CacheItem {
  sha256: string;
  originalName: string;
  displayName: string | null;
  ext: string;
  videoBytes: number;
  cacheBytes: number;
  langs: string[];
  hasInsights?: boolean;
  hasRunningInsight?: boolean;
  createdAt: number;
  lastOpenedAt: number;
}
interface CacheResp {
  items: CacheItem[];
  totals: { bytes: number; videoBytes: number; cacheBytes: number; count: number };
}
interface SettingsResp {
  settings: { cacheLimitGB: number };
}

const { t } = useI18n();
const { count: libraryCount } = useLibraryCount();

function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

const cache = ref<CacheResp | null>(null);
const cacheLimitGB = ref<number>(20);
const errMsg = ref<string | null>(null);
const pendingDelete = ref<CacheItem | null>(null);
const showClearAll = ref(false);

const queueItems = ref<QueueItemLike[]>([]);
let queuePoll: ReturnType<typeof setInterval> | null = null;

const renameItem = ref<CacheItem | null>(null);
const renameValue = ref('');
const renameSaving = ref(false);

async function refreshCache(): Promise<void> {
  try {
    const res = await $fetch<CacheResp>('/api/cache/list');
    cache.value = res;
    libraryCount.value = res.totals.count;
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'failed to load';
  }
}

async function refreshQueue(): Promise<void> {
  try {
    const res = await $fetch<{ items: QueueItemLike[] }>('/api/queue/list');
    queueItems.value = res.items;
  } catch {
    /* transient — keep last snapshot */
  }
}

function openRename(item: CacheItem): void {
  renameItem.value = item;
  renameValue.value = item.displayName ?? item.originalName;
  renameSaving.value = false;
}

// IME composition (e.g. Chinese pinyin) commits the in-progress character on
// Enter. Without this guard, that Enter also fires confirmRename — running
// before v-model receives the committed character, so the last keystroke is
// lost. `isComposing` is the W3C signal; `keyCode === 229` is the older
// fallback some browsers use during IME composition.
function onRenameEnter(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return;
  void confirmRename();
}

async function confirmRename(): Promise<void> {
  const item = renameItem.value;
  if (!item) return;
  renameSaving.value = true;
  const name = renameValue.value.trim();
  const displayName = name || null;
  try {
    await $fetch(`/api/cache/${item.sha256}`, {
      method: 'PATCH',
      body: { displayName },
    });
    item.displayName = displayName;
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'rename failed';
  } finally {
    renameItem.value = null;
  }
}

async function loadCacheLimit(): Promise<void> {
  try {
    const data = await $fetch<SettingsResp>('/api/settings');
    cacheLimitGB.value = data.settings.cacheLimitGB;
  } catch {
    /* fall back to default 20 GB — only affects progress bar denominator */
  }
}

async function confirmDeleteOne(): Promise<void> {
  const item = pendingDelete.value;
  if (!item) return;
  pendingDelete.value = null;
  try {
    await $fetch(`/api/cache/${item.sha256}`, { method: 'DELETE' });
    await refreshCache();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'delete failed';
  }
}

async function confirmClearAll(): Promise<void> {
  showClearAll.value = false;
  try {
    await $fetch('/api/cache/clear', { method: 'DELETE' });
    await refreshCache();
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : 'clear failed';
  }
}

const usageRatio = computed(() => {
  if (!cache.value) return 0;
  const limitBytes = cacheLimitGB.value * 1_000_000_000;
  if (limitBytes <= 0) return 0;
  return Math.min(1, cache.value.totals.bytes / limitBytes);
});
const overThreshold = computed(() => usageRatio.value >= 0.9);

onMounted(async () => {
  await Promise.all([refreshCache(), loadCacheLimit(), refreshQueue()]);
  queuePoll = setInterval(() => void refreshQueue(), 2_000);
});
onBeforeUnmount(() => {
  if (queuePoll) clearInterval(queuePoll);
});
</script>

<template>
  <AppShell>
    <template #header>
      <AppHeader />
    </template>

    <div class="mx-auto w-full max-w-screen-2xl px-4">
      <header class="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">{{ t('library.title') }}</h1>
          <p class="mt-1 text-sm text-muted-foreground">{{ t('library.subtitle') }}</p>
        </div>
        <Button
          v-if="cache && cache.totals.count > 0"
          variant="destructive"
          size="sm"
          @click="showClearAll = true"
        >
          <Trash2 class="h-4 w-4" />
          {{ t('library.clearAll') }}
        </Button>
      </header>

      <Alert v-if="errMsg" variant="destructive" class="mb-4">
        <AlertDescription>{{ errMsg }}</AlertDescription>
      </Alert>

      <section v-if="cache" class="card mb-6">
        <div class="mb-3 flex items-center justify-between gap-3">
          <span class="text-sm text-foreground">
            {{ t('library.totals', { count: cache.totals.count, size: fmtBytes(cache.totals.bytes) }) }}
          </span>
          <span
            class="flex items-center gap-1 font-mono text-xs tabular-nums"
            :class="overThreshold ? 'font-medium text-destructive' : 'text-muted-foreground'"
          >
            <AlertTriangle v-if="overThreshold" class="h-3.5 w-3.5" />
            {{ fmtBytes(cache.totals.bytes) }} / {{ cacheLimitGB }} GB ({{ Math.round(usageRatio * 100) }}%)
          </span>
        </div>
        <Progress
          :model-value="Math.round(usageRatio * 100)"
          class="h-2"
          :class="overThreshold ? '[&>div]:bg-destructive' : ''"
        />
      </section>

      <section
        v-if="cache && cache.items.length > 0"
        class="card-list"
      >
        <ul class="space-y-1">
          <li
            v-for="item in cache.items"
            :key="item.sha256"
            class="group flex items-center justify-between gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent/50"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-sm">
                <NuxtLink
                  :to="`/player/${item.sha256}`"
                  class="max-w-xl truncate font-medium text-foreground hover:underline"
                  :title="item.originalName"
                >{{ item.displayName || item.originalName }}</NuxtLink>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                      :aria-label="t('library.rename')"
                      @click.prevent="openRename(item)"
                    >
                      <Pencil class="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{{ t('library.rename') }}</TooltipContent>
                </Tooltip>
                <span class="font-mono text-2xs text-muted-foreground">
                  {{ fmtBytes(item.videoBytes + item.cacheBytes) }}
                </span>
              </div>
              <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <FileStatusBadges :status="getFileStatus(item, queueItems)" />
                <span v-if="item.langs.length > 0" class="font-mono">
                  {{ item.langs.join(' · ') }}
                </span>
                <span v-else-if="getFileStatus(item, queueItems).transcribe === 'none'">
                  {{ t('library.noSubtitles') }}
                </span>
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  class="opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  :aria-label="t('library.deleteOne')"
                  @click="pendingDelete = item"
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('library.deleteOne') }}</TooltipContent>
            </Tooltip>
          </li>
        </ul>
      </section>

      <EmptyState
        v-else-if="cache"
        :icon="Database"
        :title="t('library.empty.title')"
        :description="t('library.empty.description')"
        class="mt-12"
      />

      <p v-else-if="!errMsg" class="mt-12 text-center text-muted-foreground">
        {{ t('library.loading') }}
      </p>
    </div>

    <Dialog
      :open="pendingDelete !== null"
      @update:open="(v: boolean) => { if (!v) pendingDelete = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('library.deleteOneTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('library.deleteOneDesc', { name: (pendingDelete?.displayName || pendingDelete?.originalName) ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" @click="pendingDelete = null">
            {{ t('library.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmDeleteOne">
            <Trash2 class="h-4 w-4" />
            {{ t('library.confirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="showClearAll"
      @update:open="(v: boolean) => (showClearAll = v)"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <span class="grid h-8 w-8 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle class="h-4 w-4" />
            </span>
            {{ t('library.clearAllTitle') }}
          </DialogTitle>
          <DialogDescription class="pt-1">
            {{ t('library.clearAllDesc') }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" @click="showClearAll = false">
            {{ t('library.cancel') }}
          </Button>
          <Button variant="destructive" @click="confirmClearAll">
            <Trash2 class="h-4 w-4" />
            {{ t('library.clearAll') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="renameItem !== null"
      @update:open="(v: boolean) => { if (!v) renameItem = null }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('library.rename') }}</DialogTitle>
          <DialogDescription>{{ t('library.renameDesc') }}</DialogDescription>
        </DialogHeader>
        <input
          v-model="renameValue"
          type="text"
          class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          :placeholder="renameItem?.originalName"
          @keydown.enter="onRenameEnter"
        >
        <DialogFooter>
          <Button variant="secondary" @click="renameItem = null">
            {{ t('library.cancel') }}
          </Button>
          <Button :disabled="renameSaving" @click="confirmRename">
            {{ t('library.renameConfirm') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </AppShell>
</template>
