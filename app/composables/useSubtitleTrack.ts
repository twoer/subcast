/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { ref, type Ref } from 'vue';
import type { CueData } from './useSubtitleStreams';

export interface UseSubtitleTrackOptions {
  videoRef: Ref<HTMLVideoElement | null>;
}

/**
 * Owns the HTMLVideoElement's first TextTrack — adding cues as they stream
 * in, swapping the full set when the user changes languages, and toggling
 * the user-visible "captions on/off" state.
 *
 * The composable does not know about cue stores; pass cue arrays in via
 * `rebuildTrack(cues)`, and the stream composable forwards single cues via
 * `addCueToTrack(cue)`.
 */
export function useSubtitleTrack(opts: UseSubtitleTrackOptions) {
  const subsVisible = ref(true);

  function getOrCreateTrack(): TextTrack | null {
    const v = opts.videoRef.value;
    if (!v) return null;
    let track = v.textTracks[0];
    if (!track) {
      const el = v.querySelector('track');
      if (el) track = (el as HTMLTrackElement).track;
    }
    return track ?? null;
  }

  function applyTrackVisibility(): void {
    const t = getOrCreateTrack();
    if (!t) return;
    t.mode = subsVisible.value ? 'showing' : 'hidden';
  }

  function clearTrack(): void {
    const t = getOrCreateTrack();
    if (!t?.cues) return;
    for (let i = t.cues.length - 1; i >= 0; i--) t.removeCue(t.cues[i]!);
  }

  function addCueToTrack(cue: CueData): void {
    const t = getOrCreateTrack();
    if (!t) return;
    try {
      t.addCue(new VTTCue(cue.startMs / 1000, cue.endMs / 1000, cue.text));
    } catch {
      /* unsupported in some browsers */
    }
  }

  function rebuildTrack(cues: readonly CueData[]): void {
    clearTrack();
    for (const c of cues) addCueToTrack(c);
    applyTrackVisibility();
  }

  function toggleSubs(): void {
    subsVisible.value = !subsVisible.value;
    applyTrackVisibility();
  }

  return {
    subsVisible,
    addCueToTrack,
    rebuildTrack,
    toggleSubs,
  };
}
