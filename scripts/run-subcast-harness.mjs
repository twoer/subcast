#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const RECIPES = new Set(['generic-archive-pack', 'creator-brief', 'meeting-notes']);
const RECIPE_CONFIG = {
  'generic-archive-pack': {
    output: 'docs/harness/subcast-skill/outputs/generic-archive-pack',
    rubric: 'docs/harness/subcast-skill/cases/generic-archive-pack/rubric.json',
    requireInsights: false,
  },
  'creator-brief': {
    output: 'docs/harness/subcast-skill/outputs/creator-long-video',
    rubric: 'docs/harness/subcast-skill/cases/creator-long-video/rubric.json',
    requireInsights: true,
  },
  'meeting-notes': {
    output: 'docs/harness/subcast-skill/outputs/meeting-recording',
    rubric: 'docs/harness/subcast-skill/cases/meeting-recording/rubric.json',
    requireInsights: true,
  },
};

function usage() {
  return [
    'Usage:',
    '  node scripts/run-subcast-harness.mjs --recipe <generic-archive-pack|creator-brief|meeting-notes> [--hash <sha-prefix> | --input <local-file>] [--out <dir>] [--home <subcast-home>] [--lang zh-CN|en] [--redact-source-name]',
    '',
    'Runs the existing-cache Subcast harness loop: list candidate if needed, export bundle, score bundle.',
    '--input only resolves files that already have cache/<sha>/original.vtt.',
    'This does not import media, transcribe, translate, or call an LLM.',
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
    if (arg === '--redact-source-name') {
      args.redactSourceName = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'recipe') args.recipe = value;
    else if (key === 'hash') args.hash = value;
    else if (key === 'input') args.input = value;
    else if (key === 'out') args.out = value;
    else if (key === 'home') args.home = value;
    else if (key === 'lang') args.lang = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

function fail(code, message, details = {}) {
  console.error(JSON.stringify({ ok: false, code, message, ...details }));
  process.exitCode = 1;
}

function payloadError(code, message) {
  const err = new Error(code);
  err.payload = { ok: false, code, message };
  return err;
}

function scriptPath(name) {
  return resolve(process.cwd(), 'scripts', name);
}

function parseJson(output) {
  const start = output.indexOf('{');
  if (start < 0) throw new Error('NO_JSON_OUTPUT');
  return JSON.parse(output.slice(start));
}

function runNodeScript(name, args, opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath(name), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (res.status !== 0 && !opts.allowFailure) {
    const parsed = parseJson(res.stderr || res.stdout);
    const err = new Error(parsed.code ?? 'SCRIPT_FAILED');
    err.payload = parsed;
    throw err;
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json: parseJson(res.status === 0 ? res.stdout : (res.stderr || res.stdout)),
  };
}

function selectHash(home, requireInsights) {
  const args = ['--home', home];
  if (requireInsights) args.push('--with-insights');
  const res = runNodeScript('list-subcast-bundle-candidates.mjs', args);
  const candidates = Array.isArray(res.json.candidates) ? res.json.candidates : [];
  if (candidates.length === 0) {
    const code = requireInsights ? 'NO_INSIGHTS_CANDIDATES' : 'NO_CANDIDATES';
    const err = new Error(code);
    err.payload = {
      ok: false,
      code,
      message: requireInsights
        ? 'No transcribed cache candidates with AI Insights were found'
        : 'No transcribed cache candidates were found',
    };
    throw err;
  }
  candidates.sort((a, b) => {
    const ai = a.hasInsights ? 1 : 0;
    const bi = b.hasInsights ? 1 : 0;
    if (ai !== bi) return bi - ai;
    return (b.cueCount ?? 0) - (a.cueCount ?? 0);
  });
  return candidates[0].hashPrefix;
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

async function resolveInputHash(home, input) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw payloadError(
      'URL_INPUT_NOT_SUPPORTED_YET',
      'URL input is not supported by this cache-only harness yet',
    );
  }

  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    throw payloadError('INPUT_NOT_FOUND', 'Input file was not found');
  }
  if (!statSync(inputPath).isFile()) {
    throw payloadError('INPUT_NOT_FILE', 'Input path is not a file');
  }

  let fullHash;
  try {
    fullHash = await sha256File(inputPath);
  } catch {
    throw payloadError('INPUT_HASH_FAILED', 'Input file could not be read for cache lookup');
  }
  const originalVtt = join(home, 'cache', fullHash, 'original.vtt');
  if (!existsSync(originalVtt)) {
    throw payloadError(
      'INPUT_NOT_TRANSCRIBED',
      'Input file has no cached Subcast transcript; transcribe it in Subcast first',
    );
  }
  return fullHash.slice(0, 12);
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
  if (args.hash && args.input) {
    fail('AMBIGUOUS_INPUT', 'Use either --hash or --input, not both');
    return;
  }

  const cfg = RECIPE_CONFIG[args.recipe];
  const home = resolve(args.home);
  const outDir = resolve(args.out ?? cfg.output);
  const rubric = resolve(cfg.rubric);
  if (!existsSync(rubric)) {
    fail('RUBRIC_NOT_FOUND', 'Rubric file was not found');
    return;
  }

  try {
    const hash = args.hash ?? (args.input
      ? await resolveInputHash(home, args.input)
      : selectHash(home, cfg.requireInsights));
    const exportArgs = [
      '--home',
      home,
      '--hash',
      hash,
      '--recipe',
      args.recipe,
      '--lang',
      args.lang,
      '--out',
      outDir,
    ];
    if (cfg.requireInsights) exportArgs.push('--require-insights');
    if (args.redactSourceName) exportArgs.push('--redact-source-name');
    const exportRes = runNodeScript('export-subcast-bundle.mjs', exportArgs);
    const scorePath = join(outDir, 'score.json');
    const scoreRes = runNodeScript('score-subcast-bundle.mjs', [
      '--bundle',
      outDir,
      '--rubric',
      rubric,
      '--out',
      scorePath,
    ]);

    console.log(JSON.stringify({
      ok: scoreRes.json.ok === true,
      recipe: args.recipe,
      selectedHash: hash,
      cues: exportRes.json.cues,
      chapters: exportRes.json.chapters,
      insightSource: exportRes.json.insightSource,
      score: scoreRes.json.score,
      blockers: scoreRes.json.blockers ?? [],
      artifacts: [...(exportRes.json.artifacts ?? []), 'score.json'],
    }));
    if (scoreRes.json.ok !== true) process.exitCode = 1;
  } catch (err) {
    const payload = err.payload ?? {
      ok: false,
      code: err instanceof Error ? err.message : 'UNEXPECTED_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    fail(payload.code ?? 'UNEXPECTED_ERROR', payload.message ?? String(payload.code));
  }
}

main().catch((err) => {
  fail('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
});
