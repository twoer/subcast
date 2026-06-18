/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Canonical Whisper model identifiers. Single source of truth — every
 * place in the codebase that names a model (settings union, retry
 * validator, setup wizard radios, model metadata Record, hardware-tier
 * recommendation) imports from here so adding or removing a model is
 * a one-line change.
 *
 * Lives in `shared/` so both the Vue client bundle and the Nitro
 * server bundle can import via Nuxt's `#shared/*` alias.
 *
 * Pure type-level + literal constants — no runtime deps so it stays
 * cheap to inline anywhere.
 */

/** Tuple-typed array so `WhisperModelName` derives from it directly. */
export const WHISPER_MODEL_NAMES = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3',
  'large-v3-turbo',
] as const;

export type WhisperModelName = (typeof WHISPER_MODEL_NAMES)[number];

export function isWhisperModelName(value: unknown): value is WhisperModelName {
  return (
    typeof value === 'string' &&
    (WHISPER_MODEL_NAMES as readonly string[]).includes(value)
  );
}
