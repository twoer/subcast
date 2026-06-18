/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/diagnostics/logs/:date?tail=N
 *
 * Return the last N lines of `~/.subcast/logs/<date>.jsonl`. Default
 * `tail=500`, capped at 5000 so a slow client can't OOM the server by
 * asking for the full file.
 *
 * Response body is a JSON envelope `{ date, sizeBytes, lineCount,
 * truncated, body }` where `body` is the newline-joined JSONL text
 * already filtered through `sanitizeLine` (same redaction policy as
 * the diagnostic ZIP export). The wrapper carries `sizeBytes` /
 * `truncated` so the UI can show "5 KB · 200 of 482 lines" without a
 * second metadata roundtrip.
 *
 * 404 when the file doesn't exist. 400 when `:date` doesn't match
 * `YYYY-MM-DD` — the filename is built from it directly, so a
 * non-strict input is also a path-traversal risk.
 */

import { existsSync, statSync } from 'node:fs';
import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
} from 'h3';
import { logFilePath } from '../../../utils/log';
import { loadSettings } from '../../../utils/settings';
import { sanitizeLine } from '../../../utils/logSanitize';
import { tailLines } from '../../../utils/tailLines';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TAIL = 500;
const MAX_TAIL = 5000;

export default defineEventHandler(async (event) => {
  const date = getRouterParam(event, 'date');
  if (!date || !DATE_RE.test(date)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_DATE' });
  }
  const path = logFilePath(date);
  if (!existsSync(path)) {
    throw createError({ statusCode: 404, statusMessage: 'LOG_NOT_FOUND' });
  }

  const q = getQuery(event);
  const rawTail = typeof q.tail === 'string' ? Number(q.tail) : Number(q.tail ?? DEFAULT_TAIL);
  const tail = Number.isFinite(rawTail) && rawTail > 0
    ? Math.min(MAX_TAIL, Math.floor(rawTail))
    : DEFAULT_TAIL;

  const debugMode = loadSettings().debugMode;
  const lines = await tailLines(path, tail);
  const body = lines.map((l) => sanitizeLine(l, debugMode)).join('\n');

  return {
    date,
    sizeBytes: statSync(path).size,
    lineCount: lines.length,
    truncated: lines.length === tail,
    body,
  };
});
