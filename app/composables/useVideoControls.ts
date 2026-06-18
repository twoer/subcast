/* SPDX-License-Identifier: Apache-2.0 */
import { ref, watch, onMounted, onBeforeUnmount, type Ref } from 'vue';

export const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
const RATE_KEY = 'subcast.playbackRate';
const HIDE_DELAY_MS = 1800;

export interface UseVideoControlsOptions {
  videoRef: Ref<HTMLVideoElement | null>;
}

/**
 * Custom video controls — owns play/volume/duration/fullscreen state and the
 * DOM event handlers that mirror it into reactive refs. Mutates the
 * underlying HTMLVideoElement via opts.videoRef.
 *
 * Auto-installs a document `fullscreenchange` listener on mount and removes
 * it on unmount. Persists playbackRate to localStorage via a watcher.
 */
export function useVideoControls(opts: UseVideoControlsOptions) {
  const isPlaying = ref(false);
  const duration = ref(0);
  const currentTime = ref(0);
  const volume = ref(1);
  const muted = ref(false);
  const isFullscreen = ref(false);
  const controlsVisible = ref(true);
  const playbackRate = ref(1.0);

  let hideHandle: ReturnType<typeof setTimeout> | null = null;

  // --- DOM event handlers bound from the <video> element in template ---

  function onLoadedMetadata(): void {
    const v = opts.videoRef.value;
    if (!v) return;
    duration.value = v.duration;
    v.playbackRate = playbackRate.value;
  }

  function onPlayState(): void {
    const v = opts.videoRef.value;
    if (!v) return;
    isPlaying.value = !v.paused;
    scheduleHide();
  }

  function onVolumeEvent(): void {
    const v = opts.videoRef.value;
    if (!v) return;
    volume.value = v.volume;
    muted.value = v.muted;
  }

  function onTimeUpdate(e: Event): void {
    currentTime.value = (e.target as HTMLVideoElement).currentTime;
  }

  function onSeek(e: Event): void {
    const v = opts.videoRef.value;
    if (!v) return;
    v.currentTime = parseFloat((e.target as HTMLInputElement).value);
  }

  function setVolume(e: Event): void {
    const v = opts.videoRef.value;
    if (!v) return;
    v.volume = parseFloat((e.target as HTMLInputElement).value);
    v.muted = false;
  }

  function onFullscreenChange(): void {
    isFullscreen.value = !!document.fullscreenElement;
  }

  // --- Controls visibility / hide-on-idle ---

  function scheduleHide(): void {
    if (hideHandle) clearTimeout(hideHandle);
    if (isPlaying.value) {
      hideHandle = setTimeout(() => { controlsVisible.value = false; }, HIDE_DELAY_MS);
    }
  }

  function showControls(): void {
    controlsVisible.value = true;
    scheduleHide();
  }

  function onContainerLeave(): void {
    if (isPlaying.value) controlsVisible.value = false;
  }

  // --- Action callbacks (also wired into the keybindings composable) ---

  function togglePlay(): void {
    const v = opts.videoRef.value;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function seekBy(deltaSeconds: number): void {
    const v = opts.videoRef.value;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + deltaSeconds));
  }

  function jumpTo(ms: number): void {
    const v = opts.videoRef.value;
    if (!v) return;
    v.currentTime = ms / 1000;
  }

  function jumpPercent(pct: number): void {
    const v = opts.videoRef.value;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = (v.duration * pct) / 100;
  }

  function bumpVolume(delta: number): void {
    const v = opts.videoRef.value;
    if (!v) return;
    v.volume = Math.max(0, Math.min(1, v.volume + delta));
    v.muted = false;
  }

  function toggleMute(): void {
    const v = opts.videoRef.value;
    if (!v) return;
    v.muted = !v.muted;
  }

  function toggleFullscreen(): void {
    const v = opts.videoRef.value;
    if (!v) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void v.requestFullscreen();
  }

  function setPlaybackRate(rate: number): void {
    playbackRate.value = rate;
    if (opts.videoRef.value) opts.videoRef.value.playbackRate = rate;
  }

  function bumpSpeed(delta: number): void {
    const i = SPEEDS.indexOf(playbackRate.value as typeof SPEEDS[number]);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + delta))]!;
    setPlaybackRate(next);
  }

  // --- Formatting helper for the time display (mm:ss) ---

  function fmtClock(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // --- Persistence ---

  function loadPlaybackRate(): void {
    if (!import.meta.client) return;
    try {
      const raw = localStorage.getItem(RATE_KEY);
      if (!raw) return;
      const n = parseFloat(raw);
      if (Number.isFinite(n) && (SPEEDS as readonly number[]).includes(n)) {
        playbackRate.value = n;
      }
    } catch {
      /* ignore */
    }
  }

  watch(playbackRate, (r) => {
    if (opts.videoRef.value) opts.videoRef.value.playbackRate = r;
    if (import.meta.client) {
      try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* quota */ }
    }
  });

  // --- Lifecycle ---

  onMounted(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (hideHandle) clearTimeout(hideHandle);
  });

  return {
    // state
    isPlaying,
    duration,
    currentTime,
    volume,
    muted,
    isFullscreen,
    controlsVisible,
    playbackRate,
    // DOM handlers
    onLoadedMetadata,
    onPlayState,
    onVolumeEvent,
    onTimeUpdate,
    onSeek,
    setVolume,
    // hover / idle
    showControls,
    onContainerLeave,
    // actions
    togglePlay,
    seekBy,
    jumpTo,
    jumpPercent,
    bumpVolume,
    toggleMute,
    toggleFullscreen,
    setPlaybackRate,
    bumpSpeed,
    // helpers
    fmtClock,
    loadPlaybackRate,
  };
}
