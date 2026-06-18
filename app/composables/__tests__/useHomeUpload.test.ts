/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import {
  baseName,
  pickPair,
  useHomeUpload,
  type HomeUploadFetcher,
} from '../useHomeUpload';
import { useUploadStatus } from '../useUploadStatus';

function file(name: string): File {
  return new File(['x'], name);
}

describe('useHomeUpload helpers', () => {
  it('returns a file basename', () => {
    expect(baseName(file('episode.zh-CN.srt'))).toBe('episode.zh-CN');
  });

  it('picks a matching video/subtitle pair', () => {
    const video = file('episode.mp4');
    const subtitle = file('episode.zh-cn.srt');

    expect(pickPair([subtitle, video])).toEqual({ video, subtitle });
  });

  it('falls back to the first subtitle when names do not match', () => {
    const video = file('episode.mp4');
    const subtitle = file('other.vtt');

    expect(pickPair([video, subtitle])).toEqual({ video, subtitle });
  });

  it('returns null when there is no video or no subtitle', () => {
    expect(pickPair([file('only.srt')])).toBeNull();
    expect(pickPair([file('only.mp4')])).toBeNull();
  });
});

describe('useHomeUpload', () => {
  it('uploads one video and navigates to the player', async () => {
    const fetcher = vi.fn<HomeUploadFetcher>().mockResolvedValue({ hash: 'abc123' });
    const navigate = vi.fn();
    const upload = useHomeUpload({
      t: (key) => key,
      status: useUploadStatus(),
      fetcher,
      navigate,
    });

    await upload.handleFiles([file('episode.mp4')]);

    expect(fetcher).toHaveBeenCalledWith('/api/upload', {
      method: 'POST',
      body: expect.any(FormData),
    });
    expect(navigate).toHaveBeenCalledWith('/player/abc123');
    expect(upload.isUploading.value).toBe(false);
  });

  it('stores a pending pair for video plus subtitle', async () => {
    const video = file('episode.mp4');
    const subtitle = file('episode.en.srt');
    const upload = useHomeUpload({
      t: (key) => key,
      status: useUploadStatus(),
      fetcher: vi.fn<HomeUploadFetcher>(),
    });

    await upload.handleFiles([video, subtitle]);

    expect(upload.pendingPair.value).toEqual({ video, subtitle });
  });

  it('uploads a pending pair when the dialog import action is chosen', async () => {
    const fetcher = vi.fn<HomeUploadFetcher>().mockResolvedValue({ hash: 'abc123' });
    const navigate = vi.fn();
    const video = file('episode.mp4');
    const subtitle = file('episode.srt');
    const upload = useHomeUpload({
      t: (key) => key,
      status: useUploadStatus(),
      fetcher,
      navigate,
    });

    await upload.handleFiles([video, subtitle]);
    upload.dialogChoose(true);

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/player/abc123');
    });
    expect(upload.pendingPair.value).toBeNull();
  });

  it('routes multiple videos to batch preparation', async () => {
    const prepareBatchFiles = vi.fn();
    const first = file('a.mp4');
    const second = file('b.mov');
    const upload = useHomeUpload({
      t: (key) => key,
      status: useUploadStatus(),
      fetcher: vi.fn<HomeUploadFetcher>(),
      prepareBatchFiles,
    });

    await upload.handleFiles([first, second, file('note.srt')]);

    expect(prepareBatchFiles).toHaveBeenCalledWith([first, second]);
  });

  it('surfaces current no-video error behavior', async () => {
    const upload = useHomeUpload({
      t: (key) => `translated:${key}`,
      status: useUploadStatus(),
      fetcher: vi.fn<HomeUploadFetcher>(),
    });

    await upload.handleFiles([file('note.txt')]);

    expect(upload.error.value).toBe('translated:index.noVideo');
  });

  it('ignores a new upload while another is already running', async () => {
    // Simulate another flow (e.g. batch staging) already holding the shared
    // busy flag. A drop/pick arriving in that window must not fire a second
    // request or disturb the in-flight error state.
    const status = useUploadStatus();
    status.isUploading.value = true;
    status.error.value = 'batch is staging';
    const fetcher = vi.fn<HomeUploadFetcher>().mockResolvedValue({ hash: 'abc123' });
    const navigate = vi.fn();
    const upload = useHomeUpload({ t: (key) => key, status, fetcher, navigate });

    await upload.handleFiles([file('episode.mp4')]);

    expect(fetcher).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    // Pre-existing error must survive — the new request no-op'd, not reset.
    expect(upload.error.value).toBe('batch is staging');
    expect(upload.isUploading.value).toBe(true);
  });
});

