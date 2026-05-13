/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * "Export Diagnostics…" implementation (decision 8 / Phase 3.5).
 *
 * Bundles the last 7 days of structured logs plus a one-shot
 * `system.json` snapshot (OS, app version, hardware basics) into a
 * single zip the user can attach to a bug report. The action surfaces
 * from the macOS Help menu and the tray menu; both call
 * `exportDiagnostics()` here.
 *
 * Privacy: only files under `userData/logs/*.jsonl` are included. We
 * never reach into `userData/videos/` or `userData/cache/`, where user
 * media lives.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release, totalmem, cpus, arch } from 'node:os';
import { join } from 'node:path';

// `archiver` is a CommonJS package — Node's strict ESM loader refuses to
// synthesize a `default` export for it (its module.exports has named
// properties), so the natural `import archiver from 'archiver'` blows
// up at runtime with "does not provide an export named 'default'".
// createRequire bypasses ESM's static analysis and goes through Node's
// CJS loader, which is the only way to call archiver in this hybrid build.
const requireCjs = createRequire(import.meta.url);
const archiver = requireCjs('archiver') as typeof import('archiver');

// Kept in lockstep with the same constants in `server/utils/log.ts`.
// The two files run in separate processes (Electron main vs Nitro
// server) compiled from different rootDirs, so they can't share at
// runtime — if you change the format here, change it there too.
const LOG_RETENTION_DAYS = 7;
const LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

interface SystemSnapshot {
  capturedAt: string;
  app: { name: string; version: string };
  os: { platform: NodeJS.Platform; release: string; arch: string };
  hardware: { cpuModel: string; cpuCount: number; totalMemoryGB: number };
}

async function buildSystemSnapshot(): Promise<SystemSnapshot> {
  const cpuList = cpus();
  return {
    capturedAt: new Date().toISOString(),
    app: { name: app.name, version: app.getVersion() },
    os: { platform: process.platform, release: release(), arch: arch() },
    hardware: {
      cpuModel: cpuList[0]?.model ?? 'unknown',
      cpuCount: cpuList.length,
      totalMemoryGB: Number((totalmem() / 1_073_741_824).toFixed(1)),
    },
  };
}

/**
 * Filter `logs/` to files matching `YYYY-MM-DD.jsonl` whose date is within
 * the last `LOG_RETENTION_DAYS`. Anything outside that window is excluded so
 * very old logs don't bloat the zip.
 */
async function recentLogFiles(logsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const matches: string[] = [];
  for (const entry of entries) {
    if (!LOG_FILE_PATTERN.test(entry)) continue;
    const full = join(logsDir, entry);
    let mtime: number;
    try {
      mtime = (await stat(full)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime >= cutoff) matches.push(full);
  }
  return matches;
}

function timestampFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `subcast-diagnostics-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
}

export interface ExportResult {
  /** Absolute path of the produced zip, or null if the user cancelled. */
  path: string | null;
  /** Number of log files bundled (0 when no logs exist yet). */
  logCount: number;
  /** Total bytes written. */
  bytes: number;
}

/**
 * Prompt for a save location and write the diagnostics zip. Returns
 * details for the caller to show a confirmation toast. Throws only on
 * filesystem / archiver errors — the user-cancelled case resolves with
 * `path: null`.
 */
export async function exportDiagnostics(parent: BrowserWindow | null = null): Promise<ExportResult> {
  const logsDir = join(app.getPath('userData'), 'logs');
  const logs = await recentLogFiles(logsDir);
  const snapshot = await buildSystemSnapshot();

  const save = await dialog.showSaveDialog(parent ?? undefined as never, {
    title: 'Export Diagnostics',
    defaultPath: timestampFilename(),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }],
  });
  if (save.canceled || !save.filePath) return { path: null, logCount: logs.length, bytes: 0 };

  const out = createWriteStream(save.filePath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  const done = new Promise<number>((resolve, reject) => {
    out.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
  });

  archive.pipe(out);
  archive.append(JSON.stringify(snapshot, null, 2), { name: 'system.json' });
  for (const file of logs) {
    archive.file(file, { name: `logs/${file.split('/').pop()}` });
  }
  await archive.finalize();

  const bytes = await done;
  return { path: save.filePath, logCount: logs.length, bytes };
}
