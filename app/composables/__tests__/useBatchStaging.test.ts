/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import {
  useBatchStaging,
  type BatchStagingFetcher,
} from '../useBatchStaging';
import { useUploadStatus } from '../useUploadStatus';
import type { BatchOptions } from '#shared/batch';

const batchOptions: BatchOptions = {
  whisperModel: 'base',
  targetLangs: [],
  insights: false,
  diarize: false,
};

function file(name: string): File {
  return new File(['x'], name);
}

function createBatchStaging(fetcher: BatchStagingFetcher) {
  const batch = useBatchStaging({
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    status: useUploadStatus(),
    fetcher,
    refreshQueue: vi.fn(),
    refreshBatches: vi.fn(),
    refreshLibrary: vi.fn(),
  });
  return batch;
}

// Variant that accepts an externally-owned status so a test can pre-set the
// busy flag. Used only by the concurrency-guard case below.
function createBatchStagingWithStatus(fetcher: BatchStagingFetcher, status: ReturnType<typeof useUploadStatus>) {
  const batch = useBatchStaging({
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    status,
    fetcher,
    refreshQueue: vi.fn(),
    refreshBatches: vi.fn(),
    refreshLibrary: vi.fn(),
  });
  return { batch, status };
}

describe('useBatchStaging', () => {
  it('stages multiple files and tracks hashes, stage ids, reused uploads, and progress', async () => {
    const first = file('a.mp4');
    const second = file('b.mov');
    const fetcher = vi.fn<BatchStagingFetcher>()
      .mockResolvedValueOnce({ stageId: 'stage-a', hash: 'hash-a', existed: false })
      .mockResolvedValueOnce({ stageId: null, hash: 'hash-b', existed: true });
    const batch = createBatchStaging(fetcher);

    await batch.prepareBatchFiles([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(batch.pendingBatchFiles.value).toEqual([first, second]);
    expect(batch.pendingBatchHashes.value).toEqual(['hash-a', 'hash-b']);
    expect(batch.pendingBatchStageIds.value).toEqual(['stage-a']);
    expect(batch.batchReusedUploads.value).toBe(1);
    expect(batch.batchProgress.value).toBeNull();
    expect(batch.showBatchDialog.value).toBe(true);
  });

  it('reports all-failed staging and clears files', async () => {
    const fetcher = vi.fn<BatchStagingFetcher>().mockRejectedValue(new Error('fail'));
    const batch = createBatchStaging(fetcher);

    await batch.prepareBatchFiles([file('a.mp4')]);

    expect(batch.pendingBatchFiles.value).toEqual([]);
    expect(batch.pendingBatchHashes.value).toEqual([]);
    expect(batch.showBatchDialog.value).toBe(false);
  });

  it('cleans up stage ids when the dialog closes', async () => {
    const fetcher = vi.fn<BatchStagingFetcher>().mockResolvedValue({});
    const batch = createBatchStaging(fetcher);
    batch.pendingBatchFiles.value = [file('a.mp4')];
    batch.pendingBatchHashes.value = ['hash-a'];
    batch.pendingBatchStageIds.value = ['stage-a'];
    batch.batchReusedUploads.value = 1;

    batch.onBatchDialogOpenChange(false);

    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith('/api/batches/stage', {
        method: 'DELETE',
        body: { stageIds: ['stage-a'] },
      });
    });
    expect(batch.pendingBatchFiles.value).toEqual([]);
    expect(batch.pendingBatchHashes.value).toEqual([]);
    expect(batch.pendingBatchStageIds.value).toEqual([]);
    expect(batch.batchReusedUploads.value).toBe(0);
  });

  it('commits staged files and clears state after a successful batch create', async () => {
    const fetcher = vi.fn<BatchStagingFetcher>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ id: 'batch-1' });
    const batch = createBatchStaging(fetcher);
    batch.pendingBatchFiles.value = [file('a.mp4')];
    batch.pendingBatchHashes.value = ['hash-a'];
    batch.pendingBatchStageIds.value = ['stage-a'];

    await batch.startBatchUpload({ preset: 'fast', options: batchOptions });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/batches/commit', {
      method: 'POST',
      body: { stageIds: ['stage-a'] },
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/batches', {
      method: 'POST',
      body: {
        name: 'batch.defaultName:{"count":1}',
        preset: 'fast',
        videoShas: ['hash-a'],
        options: batchOptions,
      },
    });
    expect(batch.pendingBatchFiles.value).toEqual([]);
    expect(batch.pendingBatchHashes.value).toEqual([]);
    expect(batch.pendingBatchStageIds.value).toEqual([]);
  });

  it('reopens the dialog when batch creation is skipped', async () => {
    const fetcher = vi.fn<BatchStagingFetcher>()
      .mockResolvedValueOnce({ id: null, skipped: true });
    const batch = createBatchStaging(fetcher);
    batch.pendingBatchFiles.value = [file('a.mp4')];
    batch.pendingBatchHashes.value = ['hash-a'];

    await batch.startBatchUpload({ preset: 'fast', options: batchOptions });

    expect(batch.showBatchDialog.value).toBe(true);
    expect(batch.pendingBatchFiles.value).toHaveLength(1);
    expect(batch.pendingBatchHashes.value).toEqual(['hash-a']);
  });

  it('ignores staging while another upload is already running', async () => {
    const status = useUploadStatus();
    status.isUploading.value = true;
    status.error.value = 'another upload in flight';
    const fetcher = vi.fn<BatchStagingFetcher>();
    const { batch, status: batchStatus } = createBatchStagingWithStatus(fetcher, status);

    await batch.prepareBatchFiles([file('a.mp4'), file('b.mp4')]);

    expect(fetcher).not.toHaveBeenCalled();
    // Pre-existing error must survive — staging no-op'd, not reset.
    expect(batchStatus.error.value).toBe('another upload in flight');
    expect(batchStatus.isUploading.value).toBe(true);
    expect(batch.pendingBatchHashes.value).toEqual([]);
  });
});
