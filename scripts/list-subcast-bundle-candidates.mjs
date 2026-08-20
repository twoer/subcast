#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const HASH_RE = /^[a-f0-9]{12,128}$/i;
const VTT_TS =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

function usage() {
  return [
    'Usage:',
    '  node scripts/list-subcast-bundle-candidates.mjs [--home <subcast-home>] [--with-insights]',
    '',
    'Lists privacy-safe Subcast cache candidates for harness bundle export.',
    'Output excludes filenames, local paths, transcript text, prompts, and model output.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    home: process.env.SUBCAST_HOME ?? join(homedir(), '.subcast'),
    withInsights: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--with-insights') {
      args.withInsights = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'home') args.home = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exitCode = 1;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function countVttCues(path) {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let count = 0;
  for (const line of lines) {
    if (VTT_TS.test(line)) count++;
  }
  return count;
}

function loadVideoRows(db) {
  if (!db) return new Map();
  try {
    const rows = db
      .prepare(
        `SELECT sha256, duration_s, size_bytes
         FROM videos
         WHERE COALESCE(deleted_at, 0) = 0`,
      )
      .all();
    return new Map(rows.map((row) => [row.sha256, row]));
  } catch {
    const rows = db.prepare(`SELECT sha256, duration_s, size_bytes FROM videos`).all();
    return new Map(rows.map((row) => [row.sha256, row]));
  }
}

function loadInsightRows(db) {
  const out = new Map();
  if (!db) return out;
  try {
    const rows = db
      .prepare(
        `SELECT video_sha, ui_language, status, model
         FROM insight_tasks
         ORDER BY created_at DESC`,
      )
      .all();
    for (const row of rows) {
      const current = out.get(row.video_sha) ?? [];
      current.push({
        lang: row.ui_language,
        status: row.status,
        model: row.model,
      });
      out.set(row.video_sha, current);
    }
  } catch {
    // Older or cache-only homes may not have insight_tasks.
  }
  return out;
}

function artifactInsightLanguages(cacheDir) {
  const dir = join(cacheDir, 'artifacts', 'insight');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^latest-(.+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

function listCandidates(home) {
  const cacheRoot = join(home, 'cache');
  if (!existsSync(cacheRoot)) return [];
  const dbPath = join(home, 'data.sqlite');
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null;
  try {
    const videoRows = loadVideoRows(db);
    const insightRows = loadInsightRows(db);
    const candidates = [];
    for (const hash of readdirSync(cacheRoot).filter((name) => HASH_RE.test(name)).sort()) {
      const cacheDir = join(cacheRoot, hash);
      const transcriptPath = join(cacheDir, 'original.vtt');
      if (!existsSync(transcriptPath)) continue;
      const meta = readJson(join(cacheDir, 'meta.json')) ?? {};
      const artifactLangs = artifactInsightLanguages(cacheDir);
      const hasLegacyInsights = existsSync(join(cacheDir, 'insights.json'));
      const insightTasks = insightRows.get(hash) ?? [];
      const hasInsights = hasLegacyInsights || artifactLangs.length > 0;
      const row = videoRows.get(hash);
      candidates.push({
        hashPrefix: hash.slice(0, 12),
        hashLength: hash.length,
        cacheOnly: !row,
        cueCount: countVttCues(transcriptPath),
        durationS: typeof row?.duration_s === 'number' ? row.duration_s : null,
        sizeBytes: typeof row?.size_bytes === 'number' ? row.size_bytes : null,
        transcribeModel: typeof meta.model === 'string' ? meta.model : null,
        detectedLanguage: typeof meta.detectedLanguage === 'string' ? meta.detectedLanguage : null,
        hasInsights,
        insightSources: {
          legacy: hasLegacyInsights,
          artifactLanguages: artifactLangs,
          taskLanguages: [...new Set(insightTasks.map((task) => task.lang).filter(Boolean))].sort(),
        },
        doneInsightTaskCount: insightTasks.filter((task) => task.status === 'done').length,
      });
    }
    return candidates;
  } finally {
    if (db) db.close();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail('BAD_ARGS', err.message);
    console.error(usage());
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  const home = resolve(args.home);
  const candidates = listCandidates(home)
    .filter((candidate) => !args.withInsights || candidate.hasInsights);
  console.log(JSON.stringify({
    ok: true,
    homeKind: process.env.SUBCAST_HOME ? 'env' : 'resolved',
    count: candidates.length,
    candidates,
  }, null, 2));
}

main().catch((err) => {
  fail('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
});
