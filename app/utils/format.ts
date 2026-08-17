/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Format byte count as human-readable string with SI units.
 *
 * Single source of truth for the entire frontend — previously
 * duplicated independently in LogViewer / index / library / settings,
 * each with slightly different decimal precision (which made the same
 * file size render differently depending on which page you were on).
 */
export function fmtBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Format a duration in seconds as M:SS (or H:MM:SS past the hour mark).
 * Callers pass null/undefined when the duration is unknown and hide the field.
 */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}
