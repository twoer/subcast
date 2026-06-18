/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/diagnostics/logs
 *
 * List structured log files under `~/.subcast/logs/` for the in-app
 * viewer. One entry per `YYYY-MM-DD.jsonl` file with size + mtime so
 * the UI can pick the most recent file by default.
 *
 * Read-only metadata; the actual content lives behind
 * `/api/diagnostics/logs/[date]`.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineEventHandler } from 'h3';
import { SUBCAST_PATHS } from '../../utils/db';
import { LOG_FILE_PATTERN, getLogHealth, type LogHealth } from '../../utils/log';

export interface LogFileEntry {
  date: string;       // YYYY-MM-DD
  name: string;       // YYYY-MM-DD.jsonl
  sizeBytes: number;
  mtimeMs: number;
}

export interface LogsListResponse {
  files: LogFileEntry[];
  /** Health of the server-side logger itself. UI surfaces a banner when !ok. */
  writerHealth: LogHealth;
}

export default defineEventHandler(async (): Promise<LogsListResponse> => {
  if (!existsSync(SUBCAST_PATHS.logs)) {
    return { files: [], writerHealth: getLogHealth() };
  }
  const entries = await readdir(SUBCAST_PATHS.logs);
  const files: LogFileEntry[] = [];
  for (const entry of entries) {
    const m = LOG_FILE_PATTERN.exec(entry);
    if (!m) continue;
    try {
      const st = await stat(join(SUBCAST_PATHS.logs, entry));
      files.push({
        date: m[1]!,
        name: entry,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // file deleted mid-list — skip
    }
  }
  // Newest first.
  files.sort((a, b) => b.date.localeCompare(a.date));
  return { files, writerHealth: getLogHealth() };
});
