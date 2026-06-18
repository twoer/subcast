/* SPDX-License-Identifier: Apache-2.0 */
import { ref } from 'vue';
import type { BatchOptions } from '#shared/batch';
import type { UploadStatus } from './useUploadStatus';

export interface BatchStageItem {
  stageId: string | null;
  hash: string;
  existed: boolean;
}

export interface BatchCreateResponse {
  id: string | null;
  skipped?: boolean;
  readyVideos?: number;
  queuedVideos?: number;
}

export type BatchStagingFetcher = (
  request: string,
  options: { method: 'POST' | 'DELETE'; body?: unknown },
) => Promise<unknown>;

export interface BatchStagingOptions {
  t: (key: string, params?: Record<string, unknown>) => string;
  status: UploadStatus;
  fetcher?: BatchStagingFetcher;
  refreshQueue: () => Promise<unknown> | unknown;
  refreshBatches: () => Promise<unknown> | unknown;
  refreshLibrary: () => Promise<unknown> | unknown;
}

export function useBatchStaging(options: BatchStagingOptions) {
  const { isUploading, error, reset } = options.status;
  const pendingBatchFiles = ref<File[]>([]);
  const pendingBatchHashes = ref<string[]>([]);
  const pendingBatchStageIds = ref<string[]>([]);
  const showBatchDialog = ref(false);
  const batchProgress = ref<{ done: number; total: number } | null>(null);
  const batchReusedUploads = ref(0);
  const fetcher: BatchStagingFetcher = options.fetcher ?? ($fetch as unknown as BatchStagingFetcher);

  async function stageVideoForBatch(file: File): Promise<BatchStageItem> {
    const fd = new FormData();
    fd.append('video', file);
    const res = await fetcher('/api/batches/stage', {
      method: 'POST',
      body: fd,
    }) as BatchStageItem;
    if (res.existed) batchReusedUploads.value += 1;
    return res;
  }

  async function cleanupPendingBatchStages(): Promise<void> {
    const stageIds = pendingBatchStageIds.value;
    if (stageIds.length === 0) return;
    pendingBatchStageIds.value = [];
    await fetcher('/api/batches/stage', {
      method: 'DELETE',
      body: { stageIds },
    }).catch(() => { /* best-effort tmp cleanup */ });
  }

  async function prepareBatchFiles(files: File[]): Promise<void> {
    if (isUploading.value) return;
    reset();
    await cleanupPendingBatchStages();
    pendingBatchFiles.value = files;
    pendingBatchHashes.value = [];
    pendingBatchStageIds.value = [];
    batchReusedUploads.value = 0;
    isUploading.value = true;
    batchProgress.value = { done: 0, total: files.length };
    const hashes: string[] = [];
    const stageIds: string[] = [];
    const failed: string[] = [];
    try {
      for (const file of files) {
        try {
          const staged = await stageVideoForBatch(file);
          hashes.push(staged.hash);
          if (staged.stageId) stageIds.push(staged.stageId);
        } catch {
          failed.push(file.name);
        } finally {
          batchProgress.value = { done: hashes.length + failed.length, total: files.length };
        }
      }
      const uniqueHashes = [...new Set(hashes)];
      if (uniqueHashes.length === 0) {
        error.value = options.t('batch.errors.allUploadsFailed');
        pendingBatchFiles.value = [];
        return;
      }
      pendingBatchHashes.value = uniqueHashes;
      pendingBatchStageIds.value = stageIds;
      showBatchDialog.value = true;
      if (failed.length > 0) {
        error.value = options.t('batch.errors.partialStageFailed', { count: failed.length });
      }
    } finally {
      isUploading.value = false;
      batchProgress.value = null;
    }
  }

  async function startBatchUpload(payload: { preset: string; options: BatchOptions }): Promise<void> {
    const hashes = pendingBatchHashes.value;
    const stageIds = pendingBatchStageIds.value;
    if (hashes.length === 0) return;
    if (isUploading.value) return;
    showBatchDialog.value = false;
    reset();
    isUploading.value = true;
    try {
      if (stageIds.length > 0) {
        batchProgress.value = { done: 0, total: stageIds.length };
        await fetcher('/api/batches/commit', {
          method: 'POST',
          body: { stageIds },
        });
        pendingBatchStageIds.value = [];
        batchProgress.value = { done: stageIds.length, total: stageIds.length };
      }
      const res = await fetcher('/api/batches', {
        method: 'POST',
        body: {
          name: options.t('batch.defaultName', { count: hashes.length }),
          preset: payload.preset,
          videoShas: hashes,
          options: payload.options,
        },
      }) as BatchCreateResponse;
      await Promise.all([
        options.refreshQueue(),
        options.refreshBatches(),
        options.refreshLibrary(),
      ]);
      if (res.skipped) {
        pendingBatchStageIds.value = [];
        showBatchDialog.value = true;
      } else {
        pendingBatchFiles.value = [];
        pendingBatchHashes.value = [];
        pendingBatchStageIds.value = [];
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'batch failed';
    } finally {
      isUploading.value = false;
      batchProgress.value = null;
      batchReusedUploads.value = 0;
    }
  }

  function onBatchDialogOpenChange(open: boolean): void {
    showBatchDialog.value = open;
    if (!open) {
      void cleanupPendingBatchStages();
      pendingBatchFiles.value = [];
      pendingBatchHashes.value = [];
      batchReusedUploads.value = 0;
    }
  }

  return {
    pendingBatchFiles,
    pendingBatchHashes,
    pendingBatchStageIds,
    showBatchDialog,
    batchProgress,
    batchReusedUploads,
    stageVideoForBatch,
    cleanupPendingBatchStages,
    prepareBatchFiles,
    startBatchUpload,
    onBatchDialogOpenChange,
  };
}
