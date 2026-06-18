<!-- SPDX-License-Identifier: Apache-2.0 -->
<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

/**
 * Waveform-shaped progress bar. The component owns its own pointer
 * handling — replacing the native <input type="range"> so we can render
 * audio amplitude bars instead of a flat track. Peaks are expected to
 * be pre-normalized to [0,1] (the server endpoint already does this).
 *
 * Drag semantics: pointerdown anywhere on the canvas starts a "scrub"
 * session; subsequent pointermove events emit `seek` continuously until
 * pointerup or pointercancel. This matches the feel of the previous
 * <input type="range"> on macOS/Windows.
 */
const props = withDefaults(
  defineProps<{
    peaks: readonly number[];
    currentTime: number; // seconds
    duration: number;    // seconds
    /**
     * Pass true while the video is playing. The component then runs an
     * internal rAF loop that *predicts* the elapsed time between the
     * ~4Hz <video> timeupdate events, so the played-portion boundary
     * advances at 60Hz instead of jumping ~1 bar every 250ms.
     */
    isPlaying?: boolean;
    /** Default 1. Used to scale prediction when the user changes speed. */
    playbackRate?: number;
  }>(),
  { isPlaying: false, playbackRate: 1 },
);

const emit = defineEmits<{
  seek: [seconds: number];
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let scrubbing = false;

// rAF-based smoothing: between props.currentTime updates we predict the
// elapsed time so the played front and the playhead line glide at 60Hz
// instead of stuttering at the video element's ~4Hz timeupdate cadence.
let baseTime = 0;
let baseTs = 0;
let rafId: number | null = null;
// Timestamp of the last user-initiated seek through this component.
// Used to suppress the codec-keyframe-snap micro-retreat: after a seek,
// the <video> element may report a currentTime that's ~10-50ms off from
// the requested target (mp4 closed-GOP snap to the nearest preceding
// keyframe). Without this, the next watch fire pulls baseTime backward
// and the bar visibly twitches back a hair.
let lastLocalSeekTs = -Infinity;
const SEEK_SETTLE_MS = 500;
const SEEK_TOLERANCE_S = 2;
const PLAYBACK_BACKTRACK_TOLERANCE_S = 0.35;

function predictedTime(): number {
  // `baseTime` is the single source of truth — the seek handler and
  // the watch on props.currentTime both keep it accurate. When paused
  // we just display it as-is; when playing we extrapolate from the
  // last sync point at the current playback rate.
  if (!props.isPlaying) return baseTime;
  const dtSec = (performance.now() - baseTs) / 1000;
  return Math.min(props.duration, baseTime + dtSec * props.playbackRate);
}

function draw(): void {
  const cv = canvasRef.value;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth;
  const cssH = cv.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Canvas `fillStyle` doesn't resolve `var()` CSS variables, so we
  // read the computed --primary off the canvas element and reassemble
  // the hsl() string ourselves.
  const styles = getComputedStyle(cv);
  const primaryHsl = styles.getPropertyValue('--primary').trim() || '217 91% 60%';

  const n = props.peaks.length;
  if (n === 0) return;
  const now = predictedTime();
  const progress = props.duration > 0
    ? Math.min(1, Math.max(0, now / props.duration))
    : 0;
  const playedX = progress * cssW;

  // Bars encode progress via their own color — no separate tint band.
  // Played bars use the primary hue at high alpha; unplayed bars use a
  // muted translucent white. This mirrors Spotify / SoundCloud / Apple
  // Podcasts: the data IS the progress indicator, not an overlay on
  // top of it. Capped at 70% of canvas height so peaks never touch
  // the top/bottom edges; that breathing room makes the strip read as
  // a "track" instead of a forest of bars.
  const barMaxH = cssH * 0.7;
  const cy = cssH / 2;
  const barPitch = cssW / n;
  const barWidth = Math.max(1, barPitch - 1);
  // Split index by bar *center* so the bar straddling the playhead
  // joins whichever side claims its midpoint — avoids a "wrong-colored"
  // bar at the boundary while keeping it to two batched fillStyle sets
  // (one per side) instead of n.
  const splitIdx = Math.max(0, Math.min(n, Math.ceil(playedX / barPitch - 0.5)));

  ctx.fillStyle = `hsla(${primaryHsl} / 0.85)`;
  for (let i = 0; i < splitIdx; i++) {
    const peak = props.peaks[i] ?? 0;
    const barH = Math.max(1, peak * barMaxH);
    ctx.fillRect(i * barPitch, cy - barH / 2, barWidth, barH);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = splitIdx; i < n; i++) {
    const peak = props.peaks[i] ?? 0;
    const barH = Math.max(1, peak * barMaxH);
    ctx.fillRect(i * barPitch, cy - barH / 2, barWidth, barH);
  }

  // Playhead — a 1.5 px primary-colored vertical line at the
  // played/unplayed boundary. Sharp leading edge of "where am I"
  // so playback position reads instantly at a glance.
  const playheadX = Math.min(cssW - 1.5, Math.max(0, playedX));
  ctx.fillStyle = `hsl(${primaryHsl})`;
  ctx.fillRect(playheadX, 0, 1.5, cssH);
}

function tick(): void {
  draw();
  rafId = requestAnimationFrame(tick);
}

function seekFromEvent(e: PointerEvent): void {
  const cv = canvasRef.value;
  if (!cv || props.duration <= 0) return;
  const rect = cv.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
  const ratio = rect.width > 0 ? x / rect.width : 0;
  const seconds = ratio * props.duration;
  // Resync the prediction baseline NOW so the next rAF frame draws the
  // bar at the seek target instead of still extrapolating from the
  // pre-seek baseline. Without this, the bar visibly hangs back (or
  // overshoots, depending on direction) for the ~100-200 ms it takes
  // the <video> element to fire its post-seek `timeupdate`.
  baseTime = seconds;
  baseTs = performance.now();
  lastLocalSeekTs = baseTs;
  emit('seek', seconds);
}

function onPointerDown(e: PointerEvent): void {
  scrubbing = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  seekFromEvent(e);
}
function onPointerMove(e: PointerEvent): void {
  if (!scrubbing) return;
  seekFromEvent(e);
}
function onPointerUp(e: PointerEvent): void {
  if (!scrubbing) return;
  scrubbing = false;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  baseTime = props.currentTime;
  baseTs = performance.now();
  draw();
  ro = new ResizeObserver(() => draw());
  if (canvasRef.value) ro.observe(canvasRef.value);
  rafId = requestAnimationFrame(tick);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  if (rafId !== null) cancelAnimationFrame(rafId);
});

// Every prop-level currentTime update is normally an authoritative
// resync — reset the prediction baseline so we don't drift away from
// the video element's true time over long playback runs. Exception:
// for ~500 ms after a local seek (bar click / drag), the video may
// report a currentTime that's slightly off the requested target
// because of codec keyframe alignment. Ignore those micro-corrections
// so the bar doesn't visibly retreat the instant after the user clicks.
// Larger deltas always resync (covers chapter clicks, keyboard
// shortcuts, end-of-video, programmatic jumps).
watch(
  () => props.currentTime,
  (n) => {
    const now = performance.now();
    const sinceSeek = now - lastLocalSeekTs;
    if (sinceSeek < SEEK_SETTLE_MS && Math.abs(n - baseTime) < SEEK_TOLERANCE_S) {
      return;
    }
    const displayed = predictedTime();
    if (props.isPlaying && n < displayed && displayed - n < PLAYBACK_BACKTRACK_TOLERANCE_S) {
      return;
    }
    baseTime = n;
    baseTs = now;
  },
);

watch(
  () => [props.isPlaying, props.playbackRate] as const,
  () => {
    baseTime = props.currentTime;
    baseTs = performance.now();
  },
);
</script>

<template>
  <!-- Wrapper acts as the full progress-track container. Owns the
       height (consumer passes `h-7 w-full`), the rounded shape, and
       the uniform base tint (`bg-white/10`). The canvas only draws
       the colored waveform bars and the playhead — progress is
       encoded into the bar color itself, not a separate tint band. -->
  <div class="relative overflow-hidden rounded-md bg-white/10">
    <canvas
      ref="canvasRef"
      class="absolute inset-0 h-full w-full cursor-pointer touch-none select-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
  </div>
</template>
