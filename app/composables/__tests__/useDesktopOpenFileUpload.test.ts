/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import {
  useDesktopOpenFileUpload,
  type DesktopOpenFileFetcher,
  type EventTargetLike,
} from '../useDesktopOpenFileUpload';
import { useUploadStatus, type UploadStatus } from '../useUploadStatus';

function createUpload(fetcher: DesktopOpenFileFetcher, status: UploadStatus = useUploadStatus()) {
  const navigate = vi.fn();
  const upload = useDesktopOpenFileUpload({
    t: (key) => key,
    status,
    fetcher,
    navigate,
  });
  return { upload, navigate, status };
}

describe('useDesktopOpenFileUpload', () => {
  it('ignores events without a non-empty path detail', () => {
    const fetcher = vi.fn<DesktopOpenFileFetcher>();
    const { upload } = createUpload(fetcher);

    upload.onOsOpenFileEvent({ detail: '' } as CustomEvent<string>);
    upload.onOsOpenFileEvent({ detail: null } as unknown as CustomEvent<string>);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uploads a desktop path and navigates to the player', async () => {
    const fetcher = vi.fn<DesktopOpenFileFetcher>().mockResolvedValue({ hash: 'abc123' });
    const { upload, status, navigate } = createUpload(fetcher);

    await upload.handleOsOpenFile('/tmp/episode.mp4');

    expect(fetcher).toHaveBeenCalledWith('/api/desktop/upload-from-path', {
      method: 'POST',
      body: { path: '/tmp/episode.mp4' },
    });
    expect(navigate).toHaveBeenCalledWith('/player/abc123');
    expect(status.error.value).toBeNull();
    expect(status.isUploading.value).toBe(false);
  });

  it('stores upload errors with statusMessage fallback order', async () => {
    const fetcher = vi.fn<DesktopOpenFileFetcher>().mockRejectedValue({
      statusMessage: 'not allowed',
      message: 'fallback',
    });
    const { upload, status } = createUpload(fetcher);

    await upload.handleOsOpenFile('/tmp/episode.mp4');

    expect(status.error.value).toBe('not allowed');
    expect(status.isUploading.value).toBe(false);
  });

  it('registers and removes the open-file listener', () => {
    const fetcher = vi.fn<DesktopOpenFileFetcher>();
    const { upload } = createUpload(fetcher);
    const target: EventTargetLike = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    upload.startListening(target);
    upload.stopListening();

    expect(target.addEventListener).toHaveBeenCalledWith(
      'subcast:open-file',
      expect.any(Function),
    );
    expect(target.removeEventListener).toHaveBeenCalledWith(
      'subcast:open-file',
      expect.any(Function),
    );
  });

  it('ignores an OS open-file event while another upload is running', async () => {
    const status = useUploadStatus();
    status.isUploading.value = true;
    status.error.value = 'batch is staging';
    const fetcher = vi.fn<DesktopOpenFileFetcher>().mockResolvedValue({ hash: 'abc123' });
    const navigate = vi.fn();
    const upload = useDesktopOpenFileUpload({
      t: (key) => key,
      status,
      fetcher,
      navigate,
    });

    await upload.handleOsOpenFile('/tmp/episode.mp4');

    expect(fetcher).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(status.error.value).toBe('batch is staging');
    expect(status.isUploading.value).toBe(true);
  });
});
