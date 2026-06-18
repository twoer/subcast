/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

import { SUBCAST_PATHS } from '../utils/db';
import { detectHardware } from '../utils/hardware';
import { detectHealth } from '../utils/health';
import { LOG_FILE_PATTERN, LOG_RETENTION_DAYS } from '../utils/log';
import { sanitizeLine } from '../utils/logSanitize';
import { loadSettings } from '../utils/settings';

/**
 * Stable 6-char hash of (hostname + username). Mirrors the Electron-side
 * implementation in desktop/diagnostics.ts so bundles from the same machine
 * sort together regardless of which path produced them.
 */
function deviceFingerprint(): string {
  let user = '';
  try { user = userInfo().username; } catch { /* falls back to empty */ }
  return createHash('sha256').update(`${hostname()}::${user}`).digest('hex').slice(0, 6);
}

/**
 * Filename embeds version + platform + arch + device hash + timestamp so
 * support tickets carrying multiple bundles never collide. App version is
 * piped in by the Electron host via SUBCAST_APP_VERSION (set in
 * desktop/nitroEmbed.ts); a non-desktop Nitro run gets 'unknown'.
 *
 * e.g. `subcast-diag-0.3.0-darwin-arm64-a3f9b7-20260515-031637.zip`
 */
function diagnosticFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ver = process.env.SUBCAST_APP_VERSION || 'unknown';
  return `subcast-diag-${ver}-${process.platform}-${process.arch}-${deviceFingerprint()}-${ts}.zip`;
}

function recentLogs(debug: boolean): Record<string, string> {
  if (!existsSync(SUBCAST_PATHS.logs)) return {};
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const out: Record<string, string> = {};
  for (const fname of readdirSync(SUBCAST_PATHS.logs)) {
    const m = LOG_FILE_PATTERN.exec(fname);
    if (!m) continue;
    const path = join(SUBCAST_PATHS.logs, fname);
    try {
      const stMs = Date.parse(`${m[1]}T23:59:59Z`);
      if (Number.isFinite(stMs) && stMs < cutoff) continue;
      const raw = readFileSync(path, 'utf8');
      const sanitized = raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => sanitizeLine(l, debug))
        .join('\n');
      out[`logs/${fname}`] = sanitized + '\n';
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export default defineEventHandler(async (event) => {
  const settings = loadSettings();
  const hardware = detectHardware();
  // 0.2: Ollama is gone; the health probe only covers whisper-cli +
  // whisper model presence. LLM readiness is reported separately by
  // `/api/desktop/llm/status` and isn't bundled into the diagnostic
  // zip yet — keep this file scope-focused (logs + settings + hardware
  // + whisper inventory).
  const health = await detectHealth({ whisperModel: settings.whisperModel });

  const zip = new JSZip();
  // Hardware + settings + installed models — no paths, no video content
  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        retentionDays: LOG_RETENTION_DAYS,
        debugMode: settings.debugMode,
      },
      null,
      2,
    ),
  );
  zip.file(
    'settings.json',
    JSON.stringify(
      // Drop nothing — these fields are user-chosen, not sensitive
      settings,
      null,
      2,
    ),
  );
  zip.file(
    'hardware.json',
    JSON.stringify(
      {
        ...hardware,
        // LAN IP is local-network only; safe to include but redact when not debug
        lanIp: settings.debugMode ? hardware.lanIp : undefined,
      },
      null,
      2,
    ),
  );
  zip.file(
    'models.json',
    JSON.stringify(
      {
        whisper: {
          binaryPresent: health.whisper.binaryPresent,
          installed: health.whisper.models,
        },
      },
      null,
      2,
    ),
  );

  for (const [path, content] of Object.entries(recentLogs(settings.debugMode))) {
    zip.file(path, content);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${diagnosticFilename()}"`,
    'Content-Length': String(buf.length),
  });
  return buf;
});
