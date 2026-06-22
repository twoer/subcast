/* SPDX-License-Identifier: Apache-2.0 */
import { ref } from 'vue';
import type { UploadStatus } from './useUploadStatus';

/**
 * Import a video from a URL via the yt-dlp sidecar. Mirrors useHomeUpload's
 * shape: takes the shared UploadStatus + a t() function, owns one in-flight
 * import, opens an SSE stream to follow download progress, and navigates
 * to the player once the terminal "done" frame arrives with the content hash.
 *
 * Unlike the local-file flows there's no File object and no FormData — we
 * POST a JSON `{ url }` to /api/import-url to kick off a server-side job,
 * then GET /api/import-url?jobId= as an EventSource. The current jobId is
 * retained so `cancel()` can DELETE the server-side task (SIGTERM yt-dlp /
 * drop the queued entry) instead of only resetting the local UI.
 */

export type UrlImportPhase =
  | 'idle'
  | 'starting'
  | 'fetching_info'
  | 'downloading'
  | 'finalizing'
  | 'error';

export interface UrlImportFrame {
  phase: UrlImportPhase;
  /** 0..1 — undefined during fetching_info (yt-dlp hasn't reported size yet). */
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  speed?: string;
  eta?: number;
  error?: string;
}

export interface UrlImportOptions {
  t: (key: string, named?: Record<string, unknown>) => string;
  status: UploadStatus;
  fetcher?: (req: string, opts: { method: 'POST'; body: { url: string } }) => Promise<{ jobId: string }>;
  cancelFetcher?: (req: string, opts: { method: 'DELETE'; query: { jobId: string } }) => Promise<{ ok: boolean; canceled: boolean }>;
  navigate?: (path: string) => Promise<unknown> | unknown;
}

export function useUrlImport(options: UrlImportOptions) {
  const { isUploading, error, info, reset } = options.status;
  const phase = ref<UrlImportPhase>('idle');
  const percent = ref(0);
  const speed = ref<string | null>(null);
  const urlInput = ref('');
  let es: EventSource | null = null;
  /** Current server-side job id, retained between POST and terminal frame. */
  let currentJobId: string | null = null;

  const fetcher = options.fetcher ?? (($fetch as unknown) as UrlImportOptions['fetcher']);
  const cancelFetcher =
    options.cancelFetcher ?? (($fetch as unknown) as UrlImportOptions['cancelFetcher']);
  const navigate = options.navigate ?? ((path: string) => navigateTo(path));

  function closeStream(): void {
    if (es) {
      es.close();
      es = null;
    }
  }

  function resetState(): void {
    phase.value = 'idle';
    percent.value = 0;
    speed.value = null;
  }

  async function importUrl(rawUrl: string): Promise<void> {
    const url = rawUrl.trim();
    if (!url) return;
    if (isUploading.value) return;
    // Basic client-side scheme check — server validates fully.
    if (!/^https?:\/\//i.test(url)) {
      reset();
      error.value = options.t('index.urlImport.unsupportedUrl');
      return;
    }
    reset();
    resetState();
    isUploading.value = true;
    phase.value = 'starting';
    try {
      const res = await fetcher!('/api/import-url', { method: 'POST', body: { url } });
      currentJobId = res.jobId;
      openStream(res.jobId);
    } catch (err) {
      phase.value = 'error';
      error.value = err instanceof Error ? err.message : options.t('index.urlImport.error');
      isUploading.value = false;
    }
  }

  function openStream(jobId: string): void {
    closeStream();
    es = new EventSource(`/api/import-url?jobId=${encodeURIComponent(jobId)}`);
    es.addEventListener('progress', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        phase: string;
        percent?: number;
        speed?: string;
        hash?: string;
        error?: string;
      };
      onFrame(data);
    });
    es.onerror = () => {
      // Browser auto-reconnects EventSource on transient drops; the server
      // closes the stream cleanly on done/error, which also fires onerror.
      // We rely on reconnection for transient blips and on the terminal
      // frame (handled in onFrame) for completion — so this handler is a
      // no-op by design.
    };
  }

  function onFrame(data: {
    phase: string;
    percent?: number;
    speed?: string;
    hash?: string;
    error?: string;
  }): void {
    // Note: we deliberately do NOT set `info.value` (the shared Alert banner)
    // during fetching/downloading/finalizing — the inline progress bar in the
    // URL row is the feedback, and a second banner above the drop zone would
    // be redundant + visually noisy. Only `error` surfaces to the banner,
    // because failures deserve prominent visibility.
    switch (data.phase) {
      case 'queued':
      case 'fetching_info':
        phase.value = 'fetching_info';
        break;
      case 'downloading': {
        phase.value = 'downloading';
        if (typeof data.percent === 'number') percent.value = data.percent;
        if (typeof data.speed === 'string') speed.value = data.speed;
        break;
      }
      case 'finalizing':
        phase.value = 'finalizing';
        percent.value = 1;
        break;
      case 'done':
        closeStream();
        currentJobId = null;
        isUploading.value = false;
        resetState();
        void navigate(`/player/${data.hash}`);
        break;
      case 'error':
        closeStream();
        currentJobId = null;
        phase.value = 'error';
        error.value = data.error || options.t('index.urlImport.error');
        isUploading.value = false;
        break;
      case 'canceled':
        closeStream();
        currentJobId = null;
        resetState();
        isUploading.value = false;
        break;
    }
  }

  /**
   * Cancel the in-flight import. Resets the UI optimistically (so the user
   * sees immediate feedback) and fires DELETE /api/import-url?jobId= so the
   * server actually SIGTERMs yt-dlp / drops the queued entry — without this
   * the download keeps running in the background consuming disk + bandwidth.
   * The DELETE is fire-and-forget; if it fails we surface a console warning
   * rather than blocking, since the UI is already reset and the next import
   * will overwrite currentJobId anyway.
   */
  function cancel(): void {
    const jobId = currentJobId;
    closeStream();
    resetState();
    isUploading.value = false;
    info.value = null;
    currentJobId = null;
    if (jobId) {
      cancelFetcher!('/api/import-url', { method: 'DELETE', query: { jobId } }).catch(
        (err: unknown) => {
          // Best-effort: the task may already be terminal server-side (done
          // race), in which case DELETE returns canceled:false but still 200.
          // Network failures here are not actionable from the UI.
          console.warn('url import cancel failed', err);
        },
      );
    }
  }

  return {
    phase,
    percent,
    speed,
    urlInput,
    importUrl,
    cancel,
  };
}
