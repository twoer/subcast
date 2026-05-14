/* SPDX-License-Identifier: AGPL-3.0-or-later */
import type { QueueItemLike } from '~/utils/fileStatus';

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
  kind: 'transcribe' | 'translate' | 'insight';
  id: string;
  videoSha: string;
  videoName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'done' | 'error';
  model: string;
  progressPct: number;
  totalChunks?: number | null;
  doneChunks?: number;
  targetLang?: string;
  uiLanguage?: 'zh-CN' | 'en';
  createdAt: number;
  errorMsg?: string | null;
  errorCode?: string | null;
}

export interface UseQueueListOptions {
  /** Polling interval. Default 2_000 ms. */
  intervalMs?: number;
}

/**
 * Reactive snapshot of the home-tasks queue with auto-polling.
 * Replaces the duplicated refreshQueue + setInterval boilerplate
 * that previously lived in both index.vue and library.vue.
 *
 * Lifecycle: each consumer gets its own ref + interval (no shared
 * singleton). Callers that mount simultaneously will issue parallel
 * polls; in this app the index and library routes are mutually
 * exclusive so that doesn't happen in practice.
 */
export function useQueueList(opts: UseQueueListOptions = {}): {
  items: Ref<QueueItem[]>;
  loaded: Ref<boolean>;
  refresh: () => Promise<void>;
} {
  const items = ref<QueueItem[]>([]);
  // Distinguishes "not yet loaded" from "loaded, no tasks" so the
  // consuming UI can show "loading…" vs "no tasks" appropriately.
  const loaded = ref(false);
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    try {
      const res = await $fetch<{ items: QueueItem[] }>('/api/queue/list');
      items.value = res.items;
      loaded.value = true;
    } catch {
      /* network blip; ignore — keep last snapshot + loaded flag */
    }
  }

  onMounted(() => {
    void refresh();
    pollHandle = setInterval(refresh, opts.intervalMs ?? 2_000);
  });
  onBeforeUnmount(() => {
    if (pollHandle) clearInterval(pollHandle);
  });

  // Return as the public surface — the QueueItem shape satisfies
  // QueueItemLike structurally for fileStatus consumers.
  return { items, loaded, refresh };
}

// Re-export for callers that want the lite shape (for fileStatus).
export type { QueueItemLike };
