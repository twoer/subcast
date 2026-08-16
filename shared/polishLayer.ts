/* SPDX-License-Identifier: Apache-2.0 */

/**
 * The AI-polished transcript layer is stored like a translation layer —
 * a VTT in `cache/<sha>/` plus a `subtitles` row — under this fixed
 * pseudo-language id. Shared so the server (queue/cache/export paths)
 * and the app (language dropdown exclusion, variant toggle, export
 * labels) agree on the magic string.
 */
export const POLISH_LAYER_LANG = 'polished';
