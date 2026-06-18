/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Full QueueItem shape as returned by /api/queue/list. Mirrors the
 * server-side `QueueItem` interface in `server/api/queue/list.get.ts`.
 *
 * Wider than `QueueItemLike` (which only has the fields fileStatus.ts
 * reads). Index-page rendering needs the full shape; library-page
 * status badges only need QueueItemLike, but get the full shape
 * via structural compatibility.
 */
export interface QueueItem {
  kind: 'transcribe' | 'translate' | 'insight' | 'diarize';
  id: string;
  videoSha: string;
  videoName: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'done' | 'error';
  model: string;
  progressPct: number;
  totalChunks?: number | null;
  doneChunks?: number;
  targetLang?: string;
  uiLanguage?: 'zh-CN' | 'en';
  topK?: number | null;
  finalSpeakerCount?: number | null;
  createdAt: number;
  errorMsg?: string | null;
  errorCode?: string | null;
}

export interface UseQueueListOptions {
  /** Polling interval. Default 2_000 ms. */
  intervalMs?: number;
}

// Module-singleton state: AppHeader (always mounted) needs the same
// queue snapshot the page-level callers do, and the previous
// per-caller poller produced duplicated network traffic whenever
// header + page were both subscribed. Refcount the mounts so the
// interval only runs while at least one consumer is alive.
const _items = ref<QueueItem[]>([]);
// Distinguishes "not yet loaded" from "loaded, no tasks" so the
// consuming UI can show "loading…" vs "no tasks" appropriately.
const _loaded = ref(false);
let _pollHandle: ReturnType<typeof setTimeout> | null = null;
let _refCount = 0;
let _consecutiveFailures = 0;
const DEFAULT_INTERVAL_MS = 2_000;
const BACKOFF_INTERVAL_MS = 10_000;
const BACKOFF_AFTER_FAILURES = 3;

async function _refresh(): Promise<void> {
  try {
    const res = await $fetch<{ items: QueueItem[] }>('/api/queue/list');
    _items.value = res.items;
    _loaded.value = true;
    _consecutiveFailures = 0;
  } catch {
    _consecutiveFailures++;
    /* network blip; ignore — keep last snapshot + loaded flag */
  }
}

function _schedulePoll(baseIntervalMs: number, delayMs = baseIntervalMs): void {
  if (_pollHandle) clearTimeout(_pollHandle);
  _pollHandle = setTimeout(() => {
    void _refresh().finally(() => {
      if (_refCount === 0) return;
      const nextDelayMs =
        _consecutiveFailures >= BACKOFF_AFTER_FAILURES
          ? Math.max(baseIntervalMs, BACKOFF_INTERVAL_MS)
          : baseIntervalMs;
      _schedulePoll(baseIntervalMs, nextDelayMs);
    });
  }, delayMs);
}

/**
 * Reactive snapshot of the home-tasks queue with auto-polling.
 * Replaces the duplicated refreshQueue + setInterval boilerplate
 * that previously lived in both index.vue and library.vue.
 */
export function useQueueList(opts: UseQueueListOptions = {}): {
  items: Ref<QueueItem[]>;
  loaded: Ref<boolean>;
  refresh: () => Promise<void>;
} {
  onMounted(() => {
    _refCount++;
    if (_refCount === 1) {
      void _refresh();
      _schedulePoll(opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    }
  });
  onBeforeUnmount(() => {
    _refCount--;
    if (_refCount === 0 && _pollHandle) {
      clearInterval(_pollHandle);
      _pollHandle = null;
    }
  });

  // Return as the public surface — the QueueItem shape satisfies
  // QueueItemLike structurally for fileStatus consumers.
  return { items: _items, loaded: _loaded, refresh: _refresh };
}
