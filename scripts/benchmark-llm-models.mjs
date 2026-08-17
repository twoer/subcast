#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

const MODEL_IDS = ['4b', '8b', '14b'];
const FIXTURES_DIR = join('docs', 'benchmarks', 'llm', 'fixtures');
const RESULTS_DIR = join('docs', 'benchmarks', 'llm', 'results');
const TASKS = new Set(['translate', 'polish', 'insight', 'insight-map', 'insight-reduce']);

function parseArgs(argv) {
  const out = {
    run: false,
    write: false,
    models: ['8b'],
    fixtures: [],
    llamaServer: process.env.SUBCAST_LLM_BINARY_PATH || join('binaries', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    modelDir: process.env.SUBCAST_LLM_MODEL_DIR || join(process.env.SUBCAST_HOME || '.dev-userdata', 'models', 'llm'),
  };
  for (const arg of argv) {
    if (arg === '--run') {
      out.run = true;
      continue;
    }
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg.startsWith('--models=')) {
      out.models = arg
        .slice('--models='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (arg.startsWith('--fixtures=')) {
      out.fixtures = arg
        .slice('--fixtures='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (arg.startsWith('--llama-server=')) {
      out.llamaServer = arg.slice('--llama-server='.length);
    }
    if (arg.startsWith('--model-dir=')) {
      out.modelDir = arg.slice('--model-dir='.length);
    }
  }
  const badModel = out.models.find((model) => !MODEL_IDS.includes(model));
  if (badModel) {
    throw new Error(`Unsupported model id: ${badModel}`);
  }
  return out;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureHash(fixture) {
  return sha256(JSON.stringify(fixture));
}

function loadFixtures() {
  if (!existsSync(FIXTURES_DIR)) {
    throw new Error(`Missing fixture directory: ${FIXTURES_DIR}`);
  }
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
      if (typeof fixture.id !== 'string') throw new Error(`${name}: fixture.id is required`);
      if (!TASKS.has(fixture.task)) throw new Error(`${name}: unsupported task ${String(fixture.task)}`);
      return fixture;
    });
}

function filterFixtures(fixtures, ids) {
  if (ids.length === 0) return fixtures;
  const wanted = new Set(ids);
  return fixtures.filter((fixture) => wanted.has(fixture.id));
}

function scoreResult(result) {
  if (!result.ok || result.errorClass) return 0;
  let score = 60;
  if (result.jsonValid === true) score += 20;
  if (result.jsonValid === false) score -= 20;
  score += Math.min(20, Math.round(result.tokensPerSecond ?? 0));
  score -= Math.min(20, Math.floor(result.durationMs / 10_000));
  return Math.max(0, Math.min(100, score));
}

function dryRunResult(modelId, fixture) {
  const hash = fixtureHash(fixture);
  const result = {
    fixtureId: fixture.id,
    fixtureHash: hash,
    modelId,
    task: fixture.task,
    ok: false,
    dryRun: true,
    durationMs: 0,
    score: 0,
    errorClass: 'DRY_RUN',
  };
  result.score = scoreResult(result);
  return result;
}

function modelFilename(modelId) {
  return {
    '4b': 'Qwen3-4B-Q4_K_M.gguf',
    '8b': 'Qwen3-8B-Q4_K_M.gguf',
    '14b': 'Qwen3-14B-Q4_K_M.gguf',
  }[modelId];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, proc) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error('LLAMA_SERVER_EXITED');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // keep polling until the model finishes loading
    }
    await sleep(500);
  }
  throw new Error('LLAMA_SERVER_HEALTH_TIMEOUT');
}

function buildMessages(fixture) {
  if (fixture.task === 'translate') {
    return [
      { role: 'system', content: 'Translate each subtitle to the target language. Return only a JSON array of strings.' },
      { role: 'user', content: `Target language: ${fixture.targetLanguage}\nSubtitles:\n${fixture.cues.map((cue, index) => `${index + 1}. ${cue}`).join('\n')}` },
    ];
  }
  if (fixture.task === 'polish') {
    return [
      { role: 'system', content: 'Polish each subtitle. Return only a JSON array of strings with the same length as input.' },
      { role: 'user', content: `Hints: ${fixture.hints || ''}\nSubtitles:\n${fixture.cues.map((cue, index) => `${index + 1}. ${cue}`).join('\n')}` },
    ];
  }
  return [
    { role: 'system', content: 'Write a concise markdown summary and chapter list for this transcript.' },
    { role: 'user', content: fixture.transcript.map((cue) => `${cue.startMs}-${cue.endMs}: ${cue.text}`).join('\n') },
  ];
}

function responseSchema(fixture) {
  const n = fixture.expected?.jsonArrayLength;
  if ((fixture.task === 'translate' || fixture.task === 'polish') && Number.isInteger(n)) {
    return {
      type: 'array',
      items: { type: 'string' },
      minItems: n,
      maxItems: n,
    };
  }
  return undefined;
}

function jsonValidForFixture(fixture, content) {
  if (fixture.task !== 'translate' && fixture.task !== 'polish') return undefined;
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) && parsed.length === fixture.expected?.jsonArrayLength;
  } catch {
    return false;
  }
}

async function runChat(endpoint, fixture) {
  const schema = responseSchema(fixture);
  const startedAt = Date.now();
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'subcast-local',
      messages: buildMessages(fixture),
      max_tokens: fixture.task === 'insight' ? 512 : 256,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
      ...(schema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'subcast_benchmark_response', schema },
            },
          }
        : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const durationMs = Date.now() - startedAt;
  if (!res.ok) throw new Error(`LLAMA_HTTP_${res.status}`);
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content ?? '';
  const promptTokens = body?.usage?.prompt_tokens;
  const completionTokens = body?.usage?.completion_tokens;
  const jsonValid = jsonValidForFixture(fixture, content);
  const tokensPerSecond = completionTokens && durationMs > 0
    ? Number((completionTokens / (durationMs / 1000)).toFixed(2))
    : undefined;
  const ok = jsonValid === undefined ? content.trim().length > 0 : jsonValid;
  const result = {
    ok,
    durationMs,
    ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
    ...(typeof completionTokens === 'number' ? { completionTokens } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    ...(jsonValid !== undefined ? { jsonValid } : {}),
  };
  result.score = scoreResult(result);
  return result;
}

async function runModelBenchmarks(modelId, fixtures, args) {
  const modelPath = join(args.modelDir, modelFilename(modelId));
  if (!existsSync(args.llamaServer)) throw new Error(`llama-server missing: ${args.llamaServer}`);
  if (!existsSync(modelPath)) throw new Error(`model missing: ${modelPath}`);

  const port = await freePort();
  const proc = spawn(args.llamaServer, [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', '4096',
    '--parallel', '1',
    '--n-gpu-layers', process.platform === 'darwin' ? '999' : '0',
    '--cache-reuse', '64',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.resume();
  try {
    await waitForHealth(port, proc);
    const endpoint = `http://127.0.0.1:${port}`;
    const results = [];
    for (const fixture of fixtures) {
      const hash = fixtureHash(fixture);
      try {
        const measured = await runChat(endpoint, fixture);
        results.push({
          fixtureId: fixture.id,
          fixtureHash: hash,
          modelId,
          task: fixture.task,
          dryRun: false,
          ...measured,
        });
      } catch (err) {
        const result = {
          fixtureId: fixture.id,
          fixtureHash: hash,
          modelId,
          task: fixture.task,
          ok: false,
          dryRun: false,
          durationMs: 0,
          score: 0,
          errorClass: err instanceof Error ? err.name : typeof err,
        };
        results.push(result);
      }
    }
    return results;
  } finally {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 2_000).unref();
  }
}

function safeFixtureRef(fixture) {
  return {
    id: fixture.id,
    task: fixture.task,
    ...(typeof fixture.locale === 'string' ? { locale: fixture.locale } : {}),
    hash: fixtureHash(fixture),
  };
}

async function buildReport(models, fixtures, args) {
  const results = args.run
    ? (await Promise.all(models.map((modelId) => runModelBenchmarks(modelId, fixtures, args)))).flat()
    : models.flatMap((modelId) => fixtures.map((fixture) => dryRunResult(modelId, fixture)));
  return {
    schemaVersion: 'llm-benchmark-report-v1',
    generatedAt: new Date().toISOString(),
    fixtures: fixtures.map(safeFixtureRef),
    results,
  };
}

function outputPath(report) {
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  return join(RESULTS_DIR, `${stamp}.json`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = filterFixtures(loadFixtures(), args.fixtures);
  if (fixtures.length === 0) throw new Error('No fixtures selected');
  const report = await buildReport(args.models, fixtures, args);
  const text = `${JSON.stringify(report, null, 2)}\n`;

  if (args.write) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const file = outputPath(report);
    writeFileSync(file, text, 'utf8');
    console.log(`[benchmark-llm-models] wrote ${file}`);
  } else {
    process.stdout.write(text);
  }
} catch (err) {
  console.error(`[benchmark-llm-models] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
