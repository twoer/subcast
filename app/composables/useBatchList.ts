/* SPDX-License-Identifier: Apache-2.0 */
import type { BatchJobSummary } from '#shared/batch';

export interface UseBatchListOptions {
  intervalMs?: number;
}

const _items = ref<BatchJobSummary[]>([]);
const _loaded = ref(false);
let _pollHandle: ReturnType<typeof setTimeout> | null = null;
let _refCount = 0;
const DEFAULT_INTERVAL_MS = 2_000;

async function _refresh(): Promise<void> {
  try {
    const res = await $fetch<{ items: BatchJobSummary[] }>('/api/batches');
    _items.value = res.items;
    _loaded.value = true;
  } catch {
    /* keep last snapshot */
  }
}

function _schedulePoll(intervalMs: number): void {
  if (_pollHandle) clearTimeout(_pollHandle);
  _pollHandle = setTimeout(() => {
    void _refresh().finally(() => {
      if (_refCount > 0) _schedulePoll(intervalMs);
    });
  }, intervalMs);
}

export function useBatchList(opts: UseBatchListOptions = {}) {
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
      clearTimeout(_pollHandle);
      _pollHandle = null;
    }
  });

  return { items: _items, loaded: _loaded, refresh: _refresh };
}
