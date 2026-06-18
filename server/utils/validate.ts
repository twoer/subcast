/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared input validators for the API layer. Pulled out so the same
 * format checks aren't reimplemented inline at every route — each
 * duplicate is a chance for the rules to drift.
 */

/**
 * Lowercase hex SHA-256 — the form every video / asset id in Subcast
 * uses. Matches a fixed 64-char alphabet without anchoring globally so
 * it's safe to reuse across `.test()` and `.exec()` call-sites.
 */
export const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * True when `value` is a string AND matches the canonical hash format.
 * Inputs come from query strings (which h3 types as `string | string[]
 * | undefined`) or JSON bodies of `unknown` shape, so the type guard
 * is part of the contract.
 */
export function isValidHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}
