/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Whisper model catalog: download URLs (HF + Chinese mirror), expected
 * sizes, and the "recommended" tier the wizard preselects.
 *
 * Source of truth: `huggingface.co/ggerganov/whisper.cpp`. The same blobs
 * are mirrored on `hf-mirror.com` (decision 27 — manual switch when HF is
 * blocked / slow).
 *
 * Hashes are intentionally absent: populating them requires pulling the
 * real values from the upstream repo, which we'd rather do as part of a
 * release-time data refresh than hardcode by hand. The downloader skips
 * verification gracefully when sha256 is undefined; we lose tamper detect
 * until the table is filled in.
 */

import type { WhisperModelName } from './whisperScan';

export const WHISPER_FILENAMES: Record<WhisperModelName, string> = {
  tiny: 'ggml-tiny.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
  'large-v3-turbo': 'ggml-large-v3-turbo.bin',
};

export interface WhisperModelInfo {
  /** Approximate download size in bytes, for the disk-space precheck and UI labels. */
  sizeBytes: number;
  /** Lowercase hex SHA256 of the upstream blob, if known. Undefined = no verify. */
  sha256?: string;
}

export const WHISPER_MODELS: Record<WhisperModelName, WhisperModelInfo> = {
  tiny: { sizeBytes: 77 * 1024 * 1024 },
  base: { sizeBytes: 148 * 1024 * 1024 },
  small: { sizeBytes: 466 * 1024 * 1024 },
  medium: { sizeBytes: 1_530_000_000 },
  'large-v3-turbo': { sizeBytes: 1_620_000_000 },
};

export const RECOMMENDED_MODEL: WhisperModelName = 'base';

export type WhisperMirror = 'huggingface' | 'hf-mirror' | 'auto';

const MIRROR_PREFIX: Record<Exclude<WhisperMirror, 'auto'>, string> = {
  huggingface: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  'hf-mirror': 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main',
};

export function whisperDownloadUrl(
  model: WhisperModelName,
  mirror: Exclude<WhisperMirror, 'auto'>,
): string {
  return `${MIRROR_PREFIX[mirror]}/${WHISPER_FILENAMES[model]}`;
}

/**
 * Both candidate URLs for `model`. Used by the auto-mirror race
 * (`mirror === 'auto'`); the race picks whichever delivers bytes
 * faster and hands the winner back to `downloadFile()`.
 */
export function whisperDownloadUrls(model: WhisperModelName): string[] {
  return [
    whisperDownloadUrl(model, 'huggingface'),
    whisperDownloadUrl(model, 'hf-mirror'),
  ];
}
