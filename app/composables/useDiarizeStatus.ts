/* SPDX-License-Identifier: Apache-2.0 */
import { ref, computed, type Ref } from 'vue';
import type {
  ChunkSpeakerTimelineEntry,
  SpeakerId,
} from '#shared/diarization';

/**
 * Frontend mirror of GET /api/diarize/[hash]. The composable owns the
 * fetched state + provides actions (refresh / reconsolidate / rename
 * / retry / run) that update the same ref so consumers re-render.
 *
 * Only used by the player page. The Q9 view-toggle composable consumes
 * `summary` (a narrow view) so it doesn't depend on this whole module.
 */

export interface DiarizeSpeakerRow {
  speakerId: SpeakerId;
  displayName: string | null;
}

export interface DiarizeStatusBase {
  status: 'pending' | 'running' | 'done' | 'failed';
  rawSpeakerCount: number | null;
  finalSpeakerCount: number | null;
  unknownDurationS: number | null;
  unknownRatio: number | null;
  topK: number | null;
  mode: 'top_k' | 'auto' | null;
  errorCode: string | null;
  errorMsg: string | null;
  speakers: DiarizeSpeakerRow[];
  timeline: ChunkSpeakerTimelineEntry[];
}

export type DiarizeStatus = DiarizeStatusBase | { status: 'none' };

function isLoaded(s: DiarizeStatus): s is DiarizeStatusBase {
  return s.status !== 'none';
}

export function useDiarizeStatus(videoSha: Ref<string>) {
  const status = ref<DiarizeStatus | null>(null);
  const loading = ref(false);
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    if (!videoSha.value) return;
    loading.value = true;
    try {
      status.value = await $fetch<DiarizeStatus>(`/api/diarize/${videoSha.value}`);
    } catch {
      status.value = null;
    } finally {
      loading.value = false;
    }
    // Auto-poll while the pipeline is in flight. Stops as soon as the
    // task lands in a terminal state (done/failed) or evaporates (none).
    const s = status.value;
    const inFlight = s && s.status !== 'none' && (s.status === 'pending' || s.status === 'running');
    if (inFlight && pollHandle === null) {
      pollHandle = setInterval(() => {
        void refresh();
      }, 3000);
    } else if (!inFlight && pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  /** Narrow summary used by useSubtitleView's smart-default computation. */
  const summary = computed(() => {
    const s = status.value;
    if (!s || !isLoaded(s) || s.status !== 'done') return null;
    return {
      finalSpeakerCount: s.finalSpeakerCount ?? 0,
      unknownRatio: s.unknownRatio ?? 0,
    };
  });

  /** display_name override, falls back to i18n default in the consumer. */
  const displayNames = computed<Map<SpeakerId, string | null>>(() => {
    const m = new Map<SpeakerId, string | null>();
    const s = status.value;
    if (s && isLoaded(s)) {
      for (const row of s.speakers) m.set(row.speakerId, row.displayName);
    }
    return m;
  });

  /**
   * Speakers ordered by total duration desc — used to compute stable
   * color indices that don't jump around when speakers get merged
   * or the K changes (per docs §五 speakerColorIndex).
   */
  const appearanceOrder = computed<SpeakerId[]>(() => {
    const s = status.value;
    if (!s || !isLoaded(s)) return [];
    // The server already sorts speakers by duration desc.
    return s.speakers
      .map((r) => r.speakerId)
      .filter((id) => id !== 'unknown');
  });

  /** Reconsolidate (Stage 2 only, ~1-2 s). */
  async function reconsolidate(topK: number): Promise<void> {
    if (!videoSha.value) return;
    await $fetch(`/api/diarize/${videoSha.value}/reconsolidate`, {
      method: 'POST',
      body: { topK },
    });
    await refresh();
  }

  /** Full retry — wipes display_names (caller should confirm first). */
  async function retry(topK?: number): Promise<void> {
    if (!videoSha.value) return;
    const previous = status.value;
    try {
      await $fetch(`/api/diarize/${videoSha.value}/retry`, {
        method: 'POST',
        body: { topK },
      });
      await refresh();
    } catch (err) {
      status.value = previous;
      throw err;
    }
  }

  /**
   * Manual trigger (Phase 1: no auto-enqueue; player kicks off after transcribe).
   *
   * Optimistically flips the local status to 'running' so the UI
   * shows the spinner immediately — the actual server pipeline kicks
   * off in the background and we poll for the real status afterward.
   * Without this the UI would freeze for 5-7 min before the POST
   * returns, even though the server is doing useful work.
   */
  async function run(topK?: number): Promise<void> {
    if (!videoSha.value) return;
    const previous = status.value;
    // Optimistic update — give immediate visual feedback before the
    // POST round-trip. refresh() below will overwrite with real state.
    status.value = {
      status: 'running',
      rawSpeakerCount: null,
      finalSpeakerCount: null,
      unknownDurationS: null,
      unknownRatio: null,
      topK: topK ?? null,
      mode: null,
      errorCode: null,
      errorMsg: null,
      speakers: [],
      timeline: [],
    };
    try {
      await $fetch(`/api/diarize/${videoSha.value}/run`, {
        method: 'POST',
        body: { topK },
      });
      await refresh();
    } catch (err) {
      status.value = previous;
      throw err;
    }
  }

  /** Rename speaker — UPSERTs into the speakers table. */
  async function rename(speakerId: SpeakerId, displayName: string | null): Promise<void> {
    if (!videoSha.value) return;
    await $fetch(`/api/diarize/${videoSha.value}/speakers/${speakerId}`, {
      method: 'PUT',
      body: { displayName },
    });
    await refresh();
  }

  return {
    status,
    loading,
    summary,
    displayNames,
    appearanceOrder,
    refresh,
    reconsolidate,
    retry,
    run,
    rename,
  };
}
