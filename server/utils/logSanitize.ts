/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Privacy filter for log lines surfaced to the user (diagnostic ZIP and
 * in-app viewer). When `debugMode` is off, any string-valued field whose
 * key contains "path" or "name" gets replaced with `hash:<sha12>` — the
 * fingerprint is still useful for correlating events without leaking
 * filesystem layout or user content.
 *
 * Reserved scalar fields (`sha`, `taskId`, `requestId`, `lang`, `event`,
 * `level`, `ts`, `code`) pass through unchanged because they carry signal
 * the user needs to diagnose problems and don't on their own identify the
 * user. Free-text fields such as `msg` keep their text but still redact
 * embedded absolute paths.
 */

import { createHash } from 'node:crypto';

function shaShort(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

const PASSTHROUGH_KEYS = new Set([
  'sha',
  'taskId',
  'requestId',
  'lang',
  'event',
  'level',
  'ts',
  'code',
]);

const ABSOLUTE_PATH_RE =
  /(?:[A-Za-z]:\\|\/(?:Users|home|var|private|tmp|Volumes|System\/Volumes)\/)[^\s'",)]+/g;

function redactPathsInText(s: string): string {
  return s.replace(ABSOLUTE_PATH_RE, (match) => `path:${shaShort(match)}`);
}

export function sanitizeLine(line: string, debug: boolean): string {
  if (debug) return line;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (PASSTHROUGH_KEYS.has(k)) continue;
      const v = obj[k];
      if (
        typeof v === 'string' &&
        v.length > 0 &&
        (k.toLowerCase().includes('path') || k.toLowerCase().includes('name'))
      ) {
        obj[k] = `hash:${shaShort(v)}`;
      } else if (typeof v === 'string' && v.length > 0) {
        obj[k] = redactPathsInText(v);
      }
    }
    return JSON.stringify(obj);
  } catch {
    return redactPathsInText(line);
  }
}
