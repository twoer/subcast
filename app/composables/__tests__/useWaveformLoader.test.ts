/* SPDX-License-Identifier: Apache-2.0 */
import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useWaveformLoader, type WaveformFetcher } from '../useWaveformLoader';

describe('useWaveformLoader', () => {
  it('loads waveform peaks for the current hash', async () => {
    const fetcher = vi.fn<WaveformFetcher>().mockResolvedValue({
      version: 1,
      peaks: [0.1, 0.4, 0.8],
    });
    const hash = ref('abc123');
    const videoRef = ref<HTMLVideoElement | null>(null);

    const waveform = useWaveformLoader(hash, videoRef, { fetcher });
    await waveform.load();

    expect(fetcher).toHaveBeenCalledWith('/api/waveform', {
      query: { hash: 'abc123' },
    });
    expect(waveform.peaks.value).toEqual([0.1, 0.4, 0.8]);
  });

  it('accepts a computed hash', async () => {
    const fetcher = vi.fn<WaveformFetcher>().mockResolvedValue({
      version: 1,
      peaks: [0.2],
    });
    const rawHash = ref('hash-from-route');
    const hash = computed(() => rawHash.value);
    const videoRef = ref<HTMLVideoElement | null>(null);

    const waveform = useWaveformLoader(hash, videoRef, { fetcher });
    await waveform.load();

    expect(fetcher).toHaveBeenCalledWith('/api/waveform', {
      query: { hash: 'hash-from-route' },
    });
    expect(waveform.peaks.value).toEqual([0.2]);
  });

  it('keeps peaks null when the request fails', async () => {
    const fetcher = vi.fn<WaveformFetcher>().mockRejectedValue(new Error('boom'));
    const hash = ref('abc123');
    const videoRef = ref<HTMLVideoElement | null>(null);

    const waveform = useWaveformLoader(hash, videoRef, { fetcher });
    await waveform.load();

    expect(waveform.peaks.value).toBeNull();
  });

  it('ignores empty peak arrays', async () => {
    const fetcher = vi.fn<WaveformFetcher>().mockResolvedValue({
      version: 1,
      peaks: [],
    });
    const hash = ref('abc123');
    const videoRef = ref<HTMLVideoElement | null>(null);

    const waveform = useWaveformLoader(hash, videoRef, { fetcher });
    await waveform.load();

    expect(waveform.peaks.value).toBeNull();
  });

  it('seeks the video element when present', () => {
    const hash = ref('abc123');
    const video = { currentTime: 0 } as HTMLVideoElement;
    const videoRef = ref<HTMLVideoElement | null>(video);

    const waveform = useWaveformLoader(hash, videoRef, {
      fetcher: vi.fn<WaveformFetcher>(),
    });
    waveform.seek(42.5);

    expect(video.currentTime).toBe(42.5);
  });

  it('ignores seek requests when the video element is missing', () => {
    const hash = ref('abc123');
    const videoRef = ref<HTMLVideoElement | null>(null);

    const waveform = useWaveformLoader(hash, videoRef, {
      fetcher: vi.fn<WaveformFetcher>(),
    });

    expect(() => waveform.seek(42.5)).not.toThrow();
  });
});
