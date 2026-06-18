/* SPDX-License-Identifier: Apache-2.0 */

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
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { release, totalmem, cpus, arch, hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import JSZip from 'jszip';

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

/**
 * Stable 6-char fingerprint of (hostname + username). Lets us match
 * multiple diagnostic bundles to the same test user without leaking
 * either the hostname or username in plaintext. Two bundles from the
 * same machine always share the same hash; two bundles from different
 * users never collide for practical fleet sizes.
 */
function deviceFingerprint(): string {
  let user = '';
  try { user = userInfo().username; } catch { /* falls back to empty */ }
  const input = `${hostname()}::${user}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 6);
}

/**
 * Filename embeds the bits we need to triage a stray bundle:
 *   - app version  → tells us which release the bug is against
 *   - platform/arch → mac/win + apple-silicon vs x64
 *   - device hash   → multiple uploads from same user line up
 *   - timestamp     → time-orders multiple bundles from same user
 * e.g. `subcast-diag-0.3.0-darwin-arm64-a3f9b7-20260515-031637.zip`
 */
function timestampFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `subcast-diag-${app.getVersion()}-${process.platform}-${process.arch}-${deviceFingerprint()}-${ts}.zip`;
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
 * filesystem errors — the user-cancelled case resolves with `path: null`.
 *
 * Uses JSZip (same library as server/api/diagnostic.get.ts) so the two
 * export paths stay in lockstep and we only carry one zip implementation.
 * 7 days of JSONL logs fit comfortably in memory; if that ever changes,
 * swap to a streaming writer.
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

  const zip = new JSZip();
  zip.file('system.json', JSON.stringify(snapshot, null, 2));
  for (const file of logs) {
    try {
      zip.file(`logs/${basename(file)}`, await readFile(file));
    } catch {
      /* skip unreadable log file */
    }
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(save.filePath, buf);
  return { path: save.filePath, logCount: logs.length, bytes: buf.length };
}
