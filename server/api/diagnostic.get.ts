import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

import { SUBCAST_PATHS } from '../utils/db';
import { detectHardware } from '../utils/hardware';
import { detectHealth } from '../utils/health';
import { loadSettings } from '../utils/settings';

const LOG_RETENTION_DAYS = 7;

function shaShort(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function sanitizeLine(line: string, debug: boolean): string {
  if (debug) return line;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (
        k === 'sha' ||
        k === 'taskId' ||
        k === 'requestId' ||
        k === 'lang' ||
        k === 'event' ||
        k === 'level' ||
        k === 'msg' ||
        k === 'ts' ||
        k === 'code'
      ) continue;
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0 && (k.toLowerCase().includes('path') || k.toLowerCase().includes('name'))) {
        obj[k] = `hash:${shaShort(v)}`;
      }
    }
    return JSON.stringify(obj);
  } catch {
    return line;
  }
}

function recentLogs(debug: boolean): Record<string, string> {
  if (!existsSync(SUBCAST_PATHS.logs)) return {};
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const out: Record<string, string> = {};
  for (const fname of readdirSync(SUBCAST_PATHS.logs)) {
    if (!fname.endsWith('.jsonl')) continue;
    const path = join(SUBCAST_PATHS.logs, fname);
    try {
      const stMs = Date.parse(fname.replace(/\.jsonl$/, '') + 'T23:59:59Z');
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
  const health = await detectHealth({
    whisperModel: settings.whisperModel,
    ollamaModel: settings.ollamaModel,
  });

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
        ollama: {
          running: health.ollama.running,
          installed: health.ollama.models,
        },
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
  const day = new Date().toISOString().slice(0, 10);
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="subcast-diagnostic-${day}.zip"`,
    'Content-Length': String(buf.length),
  });
  return buf;
});
