/* SPDX-License-Identifier: Apache-2.0 */
import { getCurrentInstance, onBeforeUnmount, onMounted } from 'vue';
import type { UploadStatus } from './useUploadStatus';

export type DesktopOpenFileFetcher = (
  request: string,
  options: { method: 'POST'; body: { path: string } },
) => Promise<{ hash: string }>;

export interface DesktopOpenFileUploadOptions {
  t: (key: string) => string;
  status: UploadStatus;
  fetcher?: DesktopOpenFileFetcher;
  navigate?: (path: string) => Promise<unknown> | unknown;
}

export interface EventTargetLike {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

export function useDesktopOpenFileUpload(options: DesktopOpenFileUploadOptions) {
  const { isUploading, error, reset } = options.status;
  const fetcher: DesktopOpenFileFetcher =
    options.fetcher ?? ($fetch as unknown as DesktopOpenFileFetcher);
  const navigate = options.navigate ?? ((path: string) => navigateTo(path));
  let listeningTarget: EventTargetLike | null = null;

  async function handleOsOpenFile(path: string): Promise<void> {
    if (isUploading.value) return;
    reset();
    isUploading.value = true;
    try {
      const res = await fetcher('/api/desktop/upload-from-path', {
        method: 'POST',
        body: { path },
      });
      await navigate(`/player/${res.hash}`);
    } catch (err) {
      const detail = err as { statusMessage?: string; message?: string };
      error.value =
        detail.statusMessage ?? detail.message ?? options.t('desktop.home.openFileFailed');
    } finally {
      isUploading.value = false;
    }
  }

  function onOsOpenFileEvent(event: Event): void {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === 'string' && detail.length > 0) {
      void handleOsOpenFile(detail);
    }
  }

  function startListening(target: EventTargetLike = window): void {
    if (listeningTarget) return;
    target.addEventListener('subcast:open-file', onOsOpenFileEvent);
    listeningTarget = target;
  }

  function stopListening(): void {
    if (!listeningTarget) return;
    listeningTarget.removeEventListener('subcast:open-file', onOsOpenFileEvent);
    listeningTarget = null;
  }

  if (getCurrentInstance()) {
    onMounted(() => {
      startListening();
    });
    onBeforeUnmount(() => {
      stopListening();
    });
  }

  return {
    handleOsOpenFile,
    onOsOpenFileEvent,
    startListening,
    stopListening,
  };
}
