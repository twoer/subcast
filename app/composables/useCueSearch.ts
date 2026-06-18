/* SPDX-License-Identifier: Apache-2.0 */
import { ref, computed, watch, nextTick, type Ref } from 'vue';
import type { CueData } from './useSubtitleStreams';

export interface UseCueSearchOptions {
  cues: Ref<readonly CueData[]>;
}

export interface HighlightSegment {
  /** segment text */
  t: string;
  /** is this segment a match? */
  m: boolean;
}

/**
 * Free-text search over the currently-displayed cue list. The composable
 * exposes the query/match-index state plus a `matchSet` of cue indices that
 * contain the query, and `highlightSegments(text, query)` for rendering
 * &lt;mark&gt; runs in the template.
 *
 * Side effect: when `matchIdx` changes, the matching cue is scrolled into
 * view via `[data-cue-idx=...]` lookup on the next tick.
 */
export function useCueSearch(opts: UseCueSearchOptions) {
  const query = ref('');
  const matchIdx = ref<number | null>(null);

  const matchSet = computed<Set<number>>(() => {
    const q = query.value.trim().toLowerCase();
    if (!q) return new Set();
    const result = new Set<number>();
    opts.cues.value.forEach((c, i) => {
      if (c.text.toLowerCase().includes(q)) result.add(i);
    });
    return result;
  });

  function highlightSegments(text: string, q: string): HighlightSegment[] {
    const needle = q.trim();
    if (!needle) return [{ t: text, m: false }];
    const lower = text.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    const out: HighlightSegment[] = [];
    let i = 0;
    while (i < text.length) {
      const j = lower.indexOf(lowerNeedle, i);
      if (j < 0) {
        out.push({ t: text.slice(i), m: false });
        break;
      }
      if (j > i) out.push({ t: text.slice(i, j), m: false });
      out.push({ t: text.slice(j, j + lowerNeedle.length), m: true });
      i = j + lowerNeedle.length;
    }
    return out;
  }

  watch(matchIdx, (idx) => {
    if (idx == null) return;
    nextTick(() => {
      const el = document.querySelector<HTMLElement>(`[data-cue-idx="${idx}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  return {
    query,
    matchIdx,
    matchSet,
    highlightSegments,
  };
}
