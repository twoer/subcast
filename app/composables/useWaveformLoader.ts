/* SPDX-License-Identifier: Apache-2.0 */
import { ref, unref, type ComputedRef, type Ref } from 'vue';

export interface WaveformPayload {
  version: number;
  peaks: number[];
}

export type WaveformFetcher = (
  request: string,
  options?: { query?: Record<string, string> },
) => Promise<WaveformPayload>;

export function useWaveformLoader(
  hash: Ref<string> | ComputedRef<string>,
  videoRef: Ref<HTMLVideoElement | null>,
  options?: { fetcher?: WaveformFetcher },
) {
  // 500-element [0,1] array. null means the player should fall back to
  // the plain range input, matching the previous page-local behavior.
  const peaks = ref<number[] | null>(null);
  const fetcher: WaveformFetcher = options?.fetcher ?? ($fetch as unknown as WaveformFetcher);

  async function load(): Promise<void> {
    try {
      const res = await fetcher('/api/waveform', {
        query: { hash: unref(hash) },
      });
      if (Array.isArray(res.peaks) && res.peaks.length > 0) {
        peaks.value = res.peaks;
      }
    } catch {
      // Leave peaks as-is so the existing fallback range input keeps working.
    }
  }

  function seek(seconds: number): void {
    const video = videoRef.value;
    if (!video) return;
    video.currentTime = seconds;
  }

  return { peaks, load, seek };
}
