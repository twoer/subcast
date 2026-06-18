/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Hard-block model downloads when the target volume can't fit them with a
 * comfortable margin (decision 22, § 6.11). Returns rich detail so the
 * wizard can show "need X / have Y" instead of a generic error.
 *
 * Two helpers — one for model files (strict; downloads are large and slow,
 * we don't want to halfway-write then ENOSPC) and one for transient video
 * scratch space (lenient; warn but allow).
 */

import checkDiskSpaceImpl from 'check-disk-space';

/** 50% margin over the raw model size for unpack / temp / safety. */
export const MODEL_SAFETY_MULTIPLIER = 1.5;

/** Below this absolute floor on the target volume, we warn but allow video. */
export const VIDEO_FREE_FLOOR_BYTES = 100_000_000;

export interface SpaceCheck {
  ok: boolean;
  /** True when ok is false but the situation is recoverable (e.g. user could clear cache). */
  warning?: boolean;
  /** Bytes free on the target volume right now. */
  freeBytes: number;
  /** Bytes that need to be available for this operation. */
  requiredBytes: number;
  /** Render-ready message describing the shortfall. Caller decides locale. */
  message?: string;
}

export interface CheckDeps {
  /** Injected `check-disk-space` for tests. */
  checkDiskSpace?: typeof checkDiskSpaceImpl;
}

export function humanSize(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} KB`;
  return `${n} B`;
}

export async function checkSpaceForModel(
  modelSizeBytes: number,
  targetPath: string,
  deps: CheckDeps = {},
): Promise<SpaceCheck> {
  const impl = deps.checkDiskSpace ?? checkDiskSpaceImpl;
  const { free } = await impl(targetPath);
  const required = Math.ceil(modelSizeBytes * MODEL_SAFETY_MULTIPLIER);
  if (free < required) {
    return {
      ok: false,
      freeBytes: free,
      requiredBytes: required,
      message: `Need ${humanSize(required)} free, only ${humanSize(free)} available`,
    };
  }
  return { ok: true, freeBytes: free, requiredBytes: required };
}

export async function checkSpaceForVideo(
  durationSeconds: number,
  targetPath: string,
  deps: CheckDeps = {},
): Promise<SpaceCheck> {
  const impl = deps.checkDiskSpace ?? checkDiskSpaceImpl;
  const { free } = await impl(targetPath);
  // ~5 MB per minute of decoded WAV at 16kHz mono — see ffmpeg pipeline.
  const wavEstimate = Math.ceil(durationSeconds / 60) * 5_000_000;
  if (free < VIDEO_FREE_FLOOR_BYTES) {
    return {
      ok: false,
      warning: true,
      freeBytes: free,
      requiredBytes: wavEstimate,
      message: `Only ${humanSize(free)} free — transcription may run out of space`,
    };
  }
  return { ok: true, freeBytes: free, requiredBytes: wavEstimate };
}
