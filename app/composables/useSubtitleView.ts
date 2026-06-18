/* SPDX-License-Identifier: Apache-2.0 */
import { ref, computed, type Ref } from 'vue';
import { smartDefaultView, type DiarizeSummary } from '#shared/diarization';

/**
 * Owns the user's "list vs grouped" subtitle view preference and the
 * smart-default rule that picks one when they haven't explicitly
 * chosen. Persists to localStorage same shape as useSubtitleStyle.
 *
 * Three states for the stored preference (Q9c, docs/diarization-plan.md v1.5):
 *   - null   : user has never touched the toggle. Smart default applies.
 *   - 'list' : explicit. Overrides smart default everywhere.
 *   - 'grouped' : explicit.
 *
 * UX outcome: a first-time user opening a K=2 video sees grouped (smart
 * default); a first-time user opening a K=5 video sees list (smart
 * default). Once they touch the toggle, the choice locks in globally
 * until they reset via the settings page.
 */

const STORAGE_KEY = 'subcast.subtitleView';

export type SubtitleView = 'list' | 'grouped';
export type StoredPreference = SubtitleView | null;

function loadStored(): StoredPreference {
  if (!import.meta.client) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'list' || raw === 'grouped') return raw;
  } catch {
    /* SSR or no localStorage — fall through */
  }
  return null;
}

function saveStored(value: StoredPreference): void {
  if (!import.meta.client) return;
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* quota / disabled */
  }
}

/**
 * Owns the preference state. `summary` is a Ref because the diarize
 * status comes from an async API call and the composable needs to
 * recompute the smart-default when the summary lands.
 */
export function useSubtitleView(summary: Ref<DiarizeSummary | null>) {
  const userPref = ref<StoredPreference>(null);

  // Load lazily on client (SSR may hit this on hydrate; we just return
  // null until that ref is read on the client).
  function load(): void {
    userPref.value = loadStored();
  }

  /** Effective view = explicit user override if set, else smart default. */
  const view = computed<SubtitleView>(() => {
    if (userPref.value !== null) return userPref.value;
    return smartDefaultView(summary.value);
  });

  /** Whether the toggle should even be shown. K=1 / no diarize = pointless. */
  const toggleVisible = computed(() => {
    const s = summary.value;
    if (!s) return false;
    return s.finalSpeakerCount >= 2;
  });

  /** True iff the user explicitly chose this view (UI shows it as "active"). */
  function isExplicit(target: SubtitleView): boolean {
    return userPref.value === target;
  }

  /** True iff the value matches current effective view, regardless of source. */
  function isActive(target: SubtitleView): boolean {
    return view.value === target;
  }

  function setView(target: SubtitleView): void {
    userPref.value = target;
    saveStored(target);
  }

  /** Settings-page reset: go back to "follow smart default". */
  function resetToAuto(): void {
    userPref.value = null;
    saveStored(null);
  }

  return {
    /** Effective view, drives all rendering. */
    view,
    /** Hide toggle when there's no grouping decision to make. */
    toggleVisible,
    /** Reactive — `null` means following smart default. */
    userPref,
    load,
    setView,
    resetToAuto,
    isExplicit,
    isActive,
  };
}
