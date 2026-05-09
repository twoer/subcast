const KEY = 'subcast.cueListFontSizePx';
const DEFAULT_PX = 13;
const MIN_PX = 11;
const MAX_PX = 18;

export function useCueListFontSize() {
  const px = ref<number>(DEFAULT_PX);

  function load() {
    if (!import.meta.client) return;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= MIN_PX && n <= MAX_PX) px.value = n;
    } catch {
      /* ignore */
    }
  }

  function save(n: number) {
    if (!import.meta.client) return;
    const clamped = Math.max(MIN_PX, Math.min(MAX_PX, Math.round(n)));
    px.value = clamped;
    try {
      localStorage.setItem(KEY, String(clamped));
    } catch {
      /* ignore quota */
    }
  }

  return { px, load, save, MIN_PX, MAX_PX, DEFAULT_PX };
}
