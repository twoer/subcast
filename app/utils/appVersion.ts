/* SPDX-License-Identifier: Apache-2.0 */

/** Resolve the desktop bridge version first, then the build-time web version. */
export function resolveAppVersion(
  desktopVersion: string | null,
  webVersion: unknown,
): string {
  const desktop = desktopVersion?.trim();
  if (desktop) return desktop;

  if (typeof webVersion === 'string' && webVersion.trim()) {
    return webVersion.trim();
  }

  return 'unknown';
}
