#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const RECIPES = new Set(['generic-archive-pack', 'creator-brief', 'meeting-notes']);
const INSIGHT_RECIPES = new Set(['creator-brief', 'meeting-notes']);
const TERMINAL_PHASES = new Set(['bundle_ready']);
const BLOCKED_PHASES = new Set(['transcribe_failed', 'insights_failed']);

function usage() {
  return [
    'Usage:',
    '  node scripts/run-subcast-app-flow.mjs --recipe <generic-archive-pack|creator-brief|meeting-notes> (--hash <sha-prefix> | --input <local-file> | --url <http-url>) [--base-url <url>] [--api-token <token>] [--home <subcast-home>] [--out <dir>] [--lang zh-CN|en] [--timeout-ms <n>]',
    '',
    'Runs an app-backed Subcast media flow: preflight, import/start missing app jobs, wait for SSE completion, then export and score a bundle.',
    'Output excludes filenames, URLs, local paths, transcript text, prompts, and model output.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.SUBCAST_BASE_URL ?? 'http://127.0.0.1:3000',
    apiToken: process.env.SUBCAST_API_TOKEN,
    home: process.env.SUBCAST_HOME ?? join(homedir(), '.subcast'),
    lang: 'zh-CN',
    timeoutMs: 2 * 60 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
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
    else if (key === 'base-url') args.baseUrl = value;
    else if (key === 'api-token') args.apiToken = value;
    else if (key === 'home') args.home = value;
    else if (key === 'out') args.out = value;
    else if (key === 'lang') args.lang = value;
    else if (key === 'timeout-ms') args.timeoutMs = Number(value);
    else throw new Error(`Unknown option: --${key}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return args;
}

function fail(code, message, details = {}) {
  console.error(JSON.stringify({ ok: false, code, message, ...details }));
  process.exitCode = 1;
}

function payloadError(code, message, details = {}) {
  const err = new Error(code);
  err.payload = { ok: false, code, message, ...details };
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

function runNodeScript(name, args) {
  const res = spawnSync(process.execPath, [scriptPath(name), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    const parsed = parseJson(res.stderr || res.stdout);
    throw payloadError(parsed.code ?? 'SCRIPT_FAILED', parsed.message ?? String(parsed.code));
  }
  return parseJson(res.stdout);
}

function inputArgs(args) {
  if (args.hash) return ['--hash', args.hash];
  if (args.input) return ['--input', args.input];
  return ['--url', args.url];
}

function preflight(args, hashOverride = null) {
  const target = hashOverride ? ['--hash', hashOverride] : inputArgs(args);
  return runNodeScript('preflight-subcast-media-run.mjs', [
    '--home',
    resolve(args.home),
    '--recipe',
    args.recipe,
    '--lang',
    args.lang,
    '--include-full-hash',
    ...target,
  ]);
}

function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function httpJson(baseUrl, path, opts = {}) {
  const url = buildUrl(baseUrl, path, opts.query);
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.apiToken ? { 'x-subcast-token': opts.apiToken } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    throw payloadError(
      opts.failCode ?? 'APP_HTTP_FAILED',
      opts.failMessage ?? `Subcast app request failed with status ${res.status}`,
      { httpStatus: res.status },
    );
  }
  return await res.json();
}

function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const dataText = dataLines.join('\n');
  let data = {};
  if (dataText) {
    try {
      data = JSON.parse(dataText);
    } catch {
      data = {};
    }
  }
  return { event, data };
}

async function readSseUntil(baseUrl, path, opts) {
  const url = buildUrl(baseUrl, path, opts.query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const events = [];
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: opts.apiToken ? { 'x-subcast-token': opts.apiToken } : undefined,
    });
    if (!res.ok || !res.body) {
      throw payloadError(
        opts.failCode ?? 'APP_SSE_FAILED',
        opts.failMessage ?? `Subcast app stream failed with status ${res.status}`,
        { httpStatus: res.status },
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const raw = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 2);
        if (raw && !raw.startsWith(':')) {
          const frame = parseSseBlock(raw);
          events.push(safeEventSummary(frame));
          const terminal = opts.terminal(frame);
          if (terminal.done) return { frame, events };
          if (terminal.error) {
            throw payloadError(terminal.code, terminal.message);
          }
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw payloadError('APP_SSE_TIMEOUT', 'Timed out waiting for Subcast app job completion');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  throw payloadError('APP_SSE_ENDED', 'Subcast app stream ended before a terminal event');
}

function safeEventSummary(frame) {
  const phase = typeof frame.data?.phase === 'string' ? frame.data.phase : undefined;
  const status = typeof frame.data?.status === 'string' ? frame.data.status : undefined;
  return {
    event: frame.event,
    ...(phase ? { phase } : {}),
    ...(status ? { status } : {}),
  };
}

async function importUrl(args) {
  const started = await httpJson(args.baseUrl, '/api/import-url', {
    method: 'POST',
    body: { url: args.url },
    failCode: 'APP_IMPORT_URL_START_FAILED',
    failMessage: 'URL import could not be started',
    apiToken: args.apiToken,
  });
  if (typeof started.jobId !== 'string' || started.jobId.length === 0) {
    throw payloadError('APP_IMPORT_URL_BAD_RESPONSE', 'Subcast app did not return an import job id');
  }
  const { frame } = await readSseUntil(args.baseUrl, '/api/import-url', {
    query: { jobId: started.jobId },
    timeoutMs: args.timeoutMs,
    apiToken: args.apiToken,
    failCode: 'APP_IMPORT_URL_STREAM_FAILED',
    failMessage: 'URL import stream could not be opened',
    terminal(frame) {
      const phase = frame.data?.phase;
      if (phase === 'done' && typeof frame.data?.hash === 'string') return { done: true };
      if (phase === 'error' || phase === 'canceled') {
        return { error: true, code: 'APP_IMPORT_URL_FAILED', message: 'URL import did not complete' };
      }
      return {};
    },
  });
  return frame.data.hash;
}

async function importLocalFile(args) {
  const imported = await httpJson(args.baseUrl, '/api/desktop/upload-from-path', {
    method: 'POST',
    body: { path: args.input },
    failCode: 'APP_IMPORT_FILE_FAILED',
    failMessage: 'Local file import could not be completed by the Subcast app',
    apiToken: args.apiToken,
  });
  if (typeof imported.hash !== 'string' || imported.hash.length === 0) {
    throw payloadError('APP_IMPORT_FILE_BAD_RESPONSE', 'Subcast app did not return an imported video hash');
  }
  return imported.hash;
}

async function waitTranscribe(args, hash) {
  await readSseUntil(args.baseUrl, '/api/transcribe', {
    query: { hash },
    timeoutMs: args.timeoutMs,
    apiToken: args.apiToken,
    failCode: 'APP_TRANSCRIBE_START_FAILED',
    failMessage: 'Transcription stream could not be opened',
    terminal(frame) {
      if (frame.event === 'done') return { done: true };
      if (frame.event === 'error') {
        return { error: true, code: 'APP_TRANSCRIBE_FAILED', message: 'Transcription did not complete' };
      }
      return {};
    },
  });
}

async function waitInsights(args, hash) {
  await readSseUntil(args.baseUrl, '/api/insights', {
    query: { hash },
    timeoutMs: args.timeoutMs,
    apiToken: args.apiToken,
    failCode: 'APP_INSIGHTS_START_FAILED',
    failMessage: 'AI Insights stream could not be opened',
    terminal(frame) {
      if (frame.event === 'done') return { done: true };
      if (frame.event === 'error') {
        return { error: true, code: 'APP_INSIGHTS_FAILED', message: 'AI Insights did not complete' };
      }
      return {};
    },
  });
}

function runBundle(args, hashPrefix) {
  const bundleArgs = [
    '--home',
    resolve(args.home),
    '--recipe',
    args.recipe,
    '--hash',
    hashPrefix,
    '--lang',
    args.lang,
  ];
  bundleArgs.push('--redact-source-name');
  if (args.out) bundleArgs.push('--out', resolve(args.out));
  return runNodeScript('run-subcast-harness.mjs', bundleArgs);
}

async function runFlow(args) {
  const phases = [];
  let forcedHash = null;
  for (let i = 0; i < 12; i++) {
    const pf = preflight(args, forcedHash);
    phases.push(pf.phase);

    if (TERMINAL_PHASES.has(pf.phase)) {
      const bundle = runBundle(args, pf.hashPrefix);
      return {
        ok: bundle.ok === true,
        recipe: args.recipe,
        phase: 'bundle_exported',
        hashPrefix: pf.hashPrefix,
        appPhases: phases,
        score: bundle.score,
        blockers: bundle.blockers ?? [],
        artifacts: bundle.artifacts ?? [],
      };
    }

    if (BLOCKED_PHASES.has(pf.phase)) {
      throw payloadError('APP_FLOW_BLOCKED', `Preflight stopped at ${pf.phase}`);
    }

    if (pf.phase === 'url_import_needed') {
      try {
        forcedHash = await importUrl(args);
      } catch (err) {
        if (err.payload) err.payload.appPhases = phases;
        throw err;
      }
      continue;
    }
    if (pf.phase === 'import_needed') {
      try {
        forcedHash = await importLocalFile(args);
      } catch (err) {
        if (err.payload) err.payload.appPhases = phases;
        throw err;
      }
      continue;
    }
    if (pf.phase === 'transcribe_needed' || pf.phase === 'transcribe_pending') {
      const appHash = pf.hash ?? forcedHash;
      if (!appHash) throw payloadError('APP_FLOW_MISSING_FULL_HASH', 'Full video hash was not available for transcription');
      try {
        await waitTranscribe(args, appHash);
      } catch (err) {
        if (err.payload) err.payload.appPhases = phases;
        throw err;
      }
      forcedHash = appHash;
      continue;
    }
    if (INSIGHT_RECIPES.has(args.recipe) && (pf.phase === 'insights_needed' || pf.phase === 'insights_pending')) {
      const appHash = pf.hash ?? forcedHash;
      if (!appHash) throw payloadError('APP_FLOW_MISSING_FULL_HASH', 'Full video hash was not available for AI Insights');
      try {
        await waitInsights(args, appHash);
      } catch (err) {
        if (err.payload) err.payload.appPhases = phases;
        throw err;
      }
      forcedHash = appHash;
      continue;
    }

    throw payloadError('APP_FLOW_UNSUPPORTED_PHASE', `Unsupported preflight phase ${pf.phase}`);
  }
  throw payloadError('APP_FLOW_LOOP_LIMIT', 'App flow did not reach bundle_ready within the loop limit');
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
  if (!existsSync(resolve(args.home))) {
    fail('SUBCAST_HOME_NOT_FOUND', 'Subcast home was not found');
    return;
  }

  try {
    console.log(JSON.stringify(await runFlow(args)));
  } catch (err) {
    const payload = err.payload ?? {
      ok: false,
      code: err instanceof Error ? err.message : 'UNEXPECTED_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    fail(payload.code ?? 'UNEXPECTED_ERROR', payload.message ?? String(payload.code), {
      ...(Array.isArray(payload.appPhases) ? { appPhases: payload.appPhases } : {}),
      ...(Number.isFinite(payload.httpStatus) ? { httpStatus: payload.httpStatus } : {}),
    });
  }
}

main().catch((err) => {
  fail('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
});
