/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared library item count, displayed as a badge on the AppHeader
 * "Library" nav button. Backed by `useState` so multiple AppHeader
 * instances (one per page) and the Library page itself read the same
 * value across navigations — no flash of empty count when re-entering
 * a page after the count was already fetched.
 *
 * Pages that mutate the library (Library page after delete/clear, Home
 * page after upload) should call `refresh()` to keep the badge accurate.
 */

interface CountResp {
  totals: { count: number };
}

export function useLibraryCount() {
  const count = useState<number | null>('subcast:library-count', () => null);

  async function refresh(): Promise<void> {
    try {
      const res = await $fetch<CountResp>('/api/cache/list');
      count.value = res.totals.count;
    } catch {
      /* keep last value — header badge stays stable on transient failures */
    }
  }

  return { count, refresh };
}
