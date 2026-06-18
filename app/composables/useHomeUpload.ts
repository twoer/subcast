/* SPDX-License-Identifier: Apache-2.0 */
import { ref } from 'vue';
import type { UploadStatus } from './useUploadStatus';

export const SUB_EXT_RE = /\.(srt|vtt|ass)$/i;
export const VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|mp3|wav|m4a)$/i;

export interface UploadPair {
  video: File;
  subtitle: File;
}

export type HomeUploadFetcher = (
  request: string,
  options: { method: 'POST'; body: FormData },
) => Promise<{ hash: string; existed?: boolean; imported?: boolean }>;

export interface HomeUploadOptions {
  t: (key: string) => string;
  status: UploadStatus;
  fetcher?: HomeUploadFetcher;
  navigate?: (path: string) => Promise<unknown> | unknown;
  prepareBatchFiles?: (files: File[]) => Promise<void> | void;
}

export function baseName(file: File): string {
  return file.name.replace(/\.[^.]+$/, '');
}

export function pickPair(files: File[]): UploadPair | null {
  const videos = files.filter((file) => VIDEO_EXT_RE.test(file.name));
  const subs = files.filter((file) => SUB_EXT_RE.test(file.name));
  if (videos.length === 0) return null;
  const video = videos[0]!;
  const videoBase = baseName(video).toLowerCase();
  const matched =
    subs.find((subtitle) => {
      let subtitleBase = baseName(subtitle).toLowerCase();
      subtitleBase = subtitleBase.replace(/\.[a-z]{2}(-[a-z]{2})?$/, '');
      return subtitleBase === videoBase;
    }) ?? subs[0];
  if (!matched) return null;
  return { video, subtitle: matched };
}

export function useHomeUpload(options: HomeUploadOptions) {
  const { isUploading, error, info, reset } = options.status;
  const fileInput = ref<HTMLInputElement | null>(null);
  const pendingPair = ref<UploadPair | null>(null);
  const fetcher: HomeUploadFetcher = options.fetcher ?? ($fetch as unknown as HomeUploadFetcher);
  const navigate = options.navigate ?? ((path: string) => navigateTo(path));

  async function uploadVideoOnly(file: File): Promise<void> {
    if (isUploading.value) return;
    reset();
    isUploading.value = true;
    try {
      const fd = new FormData();
      fd.append('video', file);
      const res = await fetcher('/api/upload', {
        method: 'POST',
        body: fd,
      });
      await navigate(`/player/${res.hash}`);
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'upload failed';
    } finally {
      isUploading.value = false;
    }
  }

  async function uploadVideoWithSubs(video: File, subtitle: File): Promise<void> {
    if (isUploading.value) return;
    reset();
    isUploading.value = true;
    try {
      const fd = new FormData();
      fd.append('video', video);
      fd.append('subtitle', subtitle);
      const res = await fetcher('/api/upload', {
        method: 'POST',
        body: fd,
      });
      await navigate(`/player/${res.hash}`);
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'upload failed';
    } finally {
      isUploading.value = false;
    }
  }

  async function handleFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (isUploading.value) return;
    reset();
    const videos = files.filter((file) => VIDEO_EXT_RE.test(file.name));
    if (videos.length === 0) {
      error.value = options.t('index.noVideo');
      return;
    }
    if (videos.length > 1) {
      void options.prepareBatchFiles?.(videos);
      return;
    }
    const pair = pickPair(files);
    if (pair) {
      pendingPair.value = pair;
      return;
    }
    await uploadVideoOnly(videos[0]!);
  }

  function onPickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const list = input.files;
    if (!list) return;
    void handleFiles(Array.from(list));
    input.value = '';
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    const list = event.dataTransfer?.files;
    if (!list) return;
    void handleFiles(Array.from(list));
  }

  function dialogChoose(useImport: boolean): void {
    const pair = pendingPair.value;
    if (!pair) return;
    pendingPair.value = null;
    if (useImport) void uploadVideoWithSubs(pair.video, pair.subtitle);
    else void uploadVideoOnly(pair.video);
  }

  return {
    isUploading,
    error,
    info,
    fileInput,
    pendingPair,
    uploadVideoOnly,
    uploadVideoWithSubs,
    handleFiles,
    onPickFile,
    onDrop,
    dialogChoose,
  };
}

