#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';

const HASH_RE = /^[a-f0-9]{12,128}$/i;
const RECIPES = new Set(['generic-archive-pack', 'creator-brief', 'meeting-notes']);
const INSIGHT_RECIPES = new Set(['creator-brief', 'meeting-notes']);
const MEDIA_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a']);

function usage() {
  return [
    'Usage:',
    '  node scripts/preflight-subcast-media-run.mjs --recipe <generic-archive-pack|creator-brief|meeting-notes> (--hash <sha-prefix> | --input <local-file> | --url <http-url>) [--home <subcast-home>] [--lang zh-CN|en]',
    '',
    'Checks whether a media-or-url input is ready for bundle export.',
    'Output excludes filenames, URLs, local paths, transcript text, prompts, and model output.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    home: process.env.SUBCAST_HOME ?? join(homedir(), '.subcast'),
    lang: 'zh-CN',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--include-full-hash') {
      args.includeFullHash = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'recipe') args.recipe = value;
    else if (key === 'hash') args.hash = value;
    else if (key === 'input') args.input = value;
    else if (key === 'url') args.url = value;
    else if (key === 'home') args.home = value;
    else if (key === 'lang') args.lang = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exitCode = 1;
}

function payloadError(code, message) {
  const err = new Error(code);
  err.payload = { ok: false, code, message };
  return err;
}

function sha256File(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function openDb(home) {
  const dbPath = join(home, 'data.sqlite');
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function queryOne(db, sql, params = []) {
  if (!db) return null;
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function queryAll(db, sql, params = []) {
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function resolveCacheHash(home, hashPrefix) {
  const cacheRoot = join(home, 'cache');
  if (!existsSync(cacheRoot)) return null;
  const matches = readdirSync(cacheRoot)
    .filter((name) => HASH_RE.test(name))
    .filter((name) => name.toLowerCase().startsWith(hashPrefix.toLowerCase()));
  if (matches.length > 1) throw payloadError('AMBIGUOUS_HASH', 'Hash prefix matched multiple cache entries');
  return matches[0] ?? null;
}

function resolveDbHash(db, hashPrefix) {
  const rows = queryAll(
    db,
    `SELECT sha256
     FROM videos
     WHERE sha256 LIKE ? AND COALESCE(deleted_at, 0) = 0
     ORDER BY last_opened_at DESC
     LIMIT 2`,
    [`${hashPrefix}%`],
  );
  if (rows.length > 1) throw payloadError('AMBIGUOUS_HASH', 'Hash prefix matched multiple videos');
  return rows[0]?.sha256 ?? null;
}

function videoRow(db, hash) {
  return queryOne(
    db,
    `SELECT sha256, ext, source_url
     FROM videos
     WHERE sha256 = ? AND COALESCE(deleted_at, 0) = 0`,
    [hash],
  );
}

function urlVideoRow(db, url) {
  return queryOne(
    db,
    `SELECT sha256, ext, source_url
     FROM videos
     WHERE source_url = ? AND COALESCE(deleted_at, 0) = 0
     ORDER BY last_opened_at DESC
     LIMIT 1`,
    [url],
  );
}

function latestTaskStatus(db, table, hash, extraWhere = '', params = []) {
  const row = queryOne(
    db,
    `SELECT status, error_msg
     FROM ${table}
     WHERE video_sha = ? ${extraWhere}
     ORDER BY created_at DESC
     LIMIT 1`,
    [hash, ...params],
  );
  return row ? { status: row.status, hasError: Boolean(row.error_msg) } : null;
}

function artifactInsightLanguages(home, hash) {
  const dir = join(home, 'cache', hash, 'artifacts', 'insight');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^latest-(.+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

function stateForHash(home, db, hash, lang) {
  const row = videoRow(db, hash);
  const ext = row?.ext;
  const hasMediaFile = Boolean(ext && existsSync(join(home, 'videos', `${hash}${ext}`)));
  const hasTranscript = existsSync(join(home, 'cache', hash, 'original.vtt'));
  const hasLegacyInsights = existsSync(join(home, 'cache', hash, 'insights.json'));
  const artifactLangs = artifactInsightLanguages(home, hash);
  const hasArtifactInsights = artifactLangs.length > 0;
  const insightTask = latestTaskStatus(db, 'insight_tasks', hash, 'AND ui_language = ?', [lang])
    ?? latestTaskStatus(db, 'insight_tasks', hash);
  return {
    hash,
    hasVideoRow: Boolean(row),
    hasMediaFile,
    hasTranscript,
    hasInsights: hasLegacyInsights || hasArtifactInsights,
    insightSources: {
      legacy: hasLegacyInsights,
      artifactLanguages: artifactLangs,
    },
    transcribeTask: latestTaskStatus(db, 'transcribe_tasks', hash),
    insightTask,
  };
}

function classifyState(recipe, state) {
  const missingSteps = [];
  let phase = 'bundle_ready';
  let nextAction = 'export_bundle';

  if (!state.hasTranscript) {
    if (!state.hasVideoRow || !state.hasMediaFile) {
      phase = 'import_needed';
      nextAction = 'import_media';
      missingSteps.push('import');
    } else if (state.transcribeTask?.status === 'queued' || state.transcribeTask?.status === 'running') {
      phase = 'transcribe_pending';
      nextAction = 'wait_for_transcribe';
      missingSteps.push('transcribe');
    } else if (state.transcribeTask?.status === 'failed') {
      phase = 'transcribe_failed';
      nextAction = 'retry_transcribe';
      missingSteps.push('transcribe');
    } else {
      phase = 'transcribe_needed';
      nextAction = 'start_transcribe';
      missingSteps.push('transcribe');
    }
  } else if (INSIGHT_RECIPES.has(recipe) && !state.hasInsights) {
    if (state.insightTask?.status === 'queued' || state.insightTask?.status === 'running') {
      phase = 'insights_pending';
      nextAction = 'wait_for_insights';
    } else if (state.insightTask?.status === 'failed') {
      phase = 'insights_failed';
      nextAction = 'retry_insights';
    } else {
      phase = 'insights_needed';
      nextAction = 'start_insights';
    }
    missingSteps.push('insights');
  }

  return { phase, nextAction, missingSteps };
}

function commandFor(action, recipe, hashPrefix) {
  if (action === 'export_bundle') {
    return `pnpm harness:run -- --recipe ${recipe} --hash ${hashPrefix}`;
  }
  if (action === 'start_transcribe') return 'GET /api/transcribe?hash=<hash> via the running Subcast app';
  if (action === 'start_insights') return 'GET /api/insights?hash=<hash> via the running Subcast app';
  if (action === 'import_media') return 'POST /api/desktop/upload-from-path via the running Subcast desktop app';
  return null;
}

async function resolveInput(args, home, db) {
  if (args.hash) {
    if (!HASH_RE.test(args.hash)) throw payloadError('BAD_HASH', 'Hash must be a hexadecimal prefix');
    const hash = resolveDbHash(db, args.hash) ?? resolveCacheHash(home, args.hash);
    if (!hash) throw payloadError('VIDEO_NOT_FOUND', 'No Subcast video or cache entry matched that hash prefix');
    return { inputKind: 'hash', hash };
  }

  if (args.url) {
    let parsed;
    try {
      parsed = new URL(args.url);
    } catch {
      throw payloadError('BAD_URL', 'URL input is invalid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw payloadError('URL_INPUT_NOT_SUPPORTED', 'Only http(s) URL inputs are supported');
    }
    const row = urlVideoRow(db, args.url);
    if (!row) return { inputKind: 'url', phaseOverride: 'url_import_needed', nextActionOverride: 'import_url' };
    return { inputKind: 'url', hash: row.sha256 };
  }

  const inputPath = resolve(args.input);
  if (!existsSync(inputPath)) throw payloadError('INPUT_NOT_FOUND', 'Input file was not found');
  if (!statSync(inputPath).isFile()) throw payloadError('INPUT_NOT_FILE', 'Input path is not a file');
  const ext = extname(inputPath).toLowerCase();
  if (!MEDIA_EXTS.has(ext)) throw payloadError('UNSUPPORTED_MEDIA_EXT', 'Input media extension is not supported');

  let hash;
  try {
    hash = await sha256File(inputPath);
  } catch {
    throw payloadError('INPUT_HASH_FAILED', 'Input file could not be read for cache lookup');
  }
  return { inputKind: 'file', hash };
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
  if (!args.recipe || !RECIPES.has(args.recipe)) {
    fail('BAD_RECIPE', `--recipe must be one of: ${[...RECIPES].join(', ')}`);
    return;
  }
  const inputCount = [args.hash, args.input, args.url].filter(Boolean).length;
  if (inputCount !== 1) {
    fail('BAD_INPUT', 'Provide exactly one of --hash, --input, or --url');
    return;
  }

  const home = resolve(args.home);
  const db = openDb(home);
  try {
    const resolved = await resolveInput(args, home, db);
    if (resolved.phaseOverride) {
      console.log(JSON.stringify({
        ok: true,
        recipe: args.recipe,
        inputKind: resolved.inputKind,
        phase: resolved.phaseOverride,
        missingSteps: ['import'],
        nextAction: resolved.nextActionOverride,
        nextCommand: 'POST /api/import-url via the running Subcast app',
      }));
      return;
    }

    const state = stateForHash(home, db, resolved.hash, args.lang);
    const classified = classifyState(args.recipe, state);
    const hashPrefix = resolved.hash.slice(0, 12);
    console.log(JSON.stringify({
      ok: true,
      recipe: args.recipe,
      inputKind: resolved.inputKind,
      phase: classified.phase,
      hashPrefix,
      ...(args.includeFullHash ? { hash: resolved.hash } : {}),
      hasVideoRow: state.hasVideoRow,
      hasMediaFile: state.hasMediaFile,
      hasTranscript: state.hasTranscript,
      hasInsights: state.hasInsights,
      transcribeStatus: state.transcribeTask?.status ?? null,
      insightStatus: state.insightTask?.status ?? null,
      missingSteps: classified.missingSteps,
      nextAction: classified.nextAction,
      nextCommand: commandFor(classified.nextAction, args.recipe, hashPrefix),
    }));
  } finally {
    if (db) db.close();
  }
}

main().catch((err) => {
  const payload = err.payload ?? {
    ok: false,
    code: err instanceof Error ? err.message : 'UNEXPECTED_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
  fail(payload.code ?? 'UNEXPECTED_ERROR', payload.message ?? String(payload.code));
});
