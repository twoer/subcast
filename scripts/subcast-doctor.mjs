#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Read-only project health checks for fragile Subcast release paths.
 *
 * This script reports problems but never repairs them. Keep mutations in
 * explicit commands such as ensure-sqlite-abi or fetch-* scripts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const require = createRequire(import.meta.url);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

const results = [];

function add(status, name, detail) {
  results.push({ status, name, detail });
}

function ok(name, detail) {
  add('ok', name, detail);
}

function warn(name, detail) {
  add('warn', name, detail);
}

function fail(name, detail) {
  add('fail', name, detail);
}

function readText(path) {
  return readFileSync(join(REPO, path), 'utf8');
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPO,
    encoding: 'utf8',
    ...options,
  });
}

function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isExecutable(path) {
  if (process.platform === 'win32') return true;
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function checkPackageBasics() {
  const pkg = JSON.parse(readText('package.json'));
  if (pkg.packageManager?.startsWith('pnpm@')) {
    ok('package manager', pkg.packageManager);
  } else {
    fail('package manager', 'package.json should declare pnpm in packageManager');
  }

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 22) {
    ok('node runtime', `Node ${process.version}`);
  } else {
    warn('node runtime', `Node ${process.version}; repo is usually developed with Node 22+`);
  }

  if (pkg.scripts?.['subcast:doctor'] === 'node scripts/subcast-doctor.mjs') {
    ok('doctor script', 'package.json exposes pnpm subcast:doctor');
  } else {
    fail('doctor script', 'package.json should expose "subcast:doctor"');
  }
}

function checkBetterSqliteAbi() {
  const probe = `
    try {
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.close();
      process.stdout.write(process.versions.modules);
    } catch (err) {
      process.stdout.write('LOAD_FAIL:' + err.message);
    }
  `;
  const res = run(process.execPath, ['-e', probe]);
  const stdout = (res.stdout || '').trim();
  if (res.status === 0 && /^\d+$/.test(stdout)) {
    ok('better-sqlite3 ABI', `loads under current Node ABI ${stdout}`);
    return;
  }

  const raw = stdout.startsWith('LOAD_FAIL:')
    ? stdout.slice('LOAD_FAIL:'.length)
    : (res.stderr || stdout || 'unknown error');
  const compiled = /NODE_MODULE_VERSION\s+(\d+)/.exec(raw)?.[1];
  const required = /requires\s+NODE_MODULE_VERSION\s+(\d+)/.exec(raw)?.[1] ?? process.versions.modules;
  const msg = compiled
    ? `current binary ABI ${compiled}, current Node requires ABI ${required}`
    : raw.trim().split('\n')[0];
  warn(
    'better-sqlite3 ABI',
    `${msg}; run node scripts/ensure-sqlite-abi.mjs node or electron`,
  );
}

function checkAppBoundary() {
  const boundary = run('rg', ['-n', 'desktop/modelManager|\\.\\./\\.\\./desktop', 'app']);
  if (boundary.status === 0) {
    fail('app boundary', boundary.stdout.trim());
  } else if (boundary.status === 1) {
    ok('app boundary', 'app/ has no desktop imports');
  } else {
    warn('app boundary', boundary.stderr.trim() || 'rg unavailable');
  }
}

function checkSharedBoundary() {
  const sharedDir = join(REPO, 'shared');
  const offenders = [];
  for (const file of walkFiles(sharedDir).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))) {
    const rel = relative(REPO, file);
    const source = readFileSync(file, 'utf8');
    const importHits = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of importHits) {
      if (
        spec.startsWith('node:')
        || spec === 'fs'
        || spec === 'path'
        || spec === 'process'
        || spec.includes('/server/')
        || spec.includes('/desktop/')
        || spec.startsWith('../server')
        || spec.startsWith('../desktop')
      ) {
        offenders.push(`${rel}: ${spec}`);
      }
    }
    if (/\bprocess\./.test(source)) offenders.push(`${rel}: process.*`);
  }

  if (offenders.length === 0) {
    ok('shared boundary', 'shared/ stays runtime-neutral');
  } else {
    fail('shared boundary', offenders.join('\n'));
  }
}

function checkTrackedBinaries() {
  const res = run('git', ['ls-files', 'binaries']);
  if (res.status !== 0) {
    warn('tracked binaries', res.stderr.trim() || 'git ls-files failed');
    return;
  }
  const tracked = res.stdout.trim().split('\n').filter(Boolean);
  const unexpected = tracked.filter((path) => path !== 'binaries/README.md');
  if (unexpected.length === 0) {
    ok('tracked binaries', 'only binaries/README.md is tracked');
  } else {
    fail('tracked binaries', unexpected.join('\n'));
  }
}

function checkLocalReleaseInputs() {
  const platformDir = `${process.platform}-${process.arch}`;
  const required = [
    [`binaries/${platformDir}/whisper-cli${EXE_SUFFIX}`, { executable: true }],
    [`binaries/${platformDir}/llama-server${EXE_SUFFIX}`, { executable: true }],
    ['binaries/models/ggml-base.bin', { minBytes: 130 * 1024 * 1024 }],
    ['binaries/models/silero_vad.onnx', { minBytes: 1 * 1024 * 1024 }],
    [
      'binaries/models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
      { minBytes: 5 * 1024 * 1024 },
    ],
    [
      'binaries/models/diarization/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
      { minBytes: 25 * 1024 * 1024 },
    ],
  ];

  if (process.platform === 'darwin') {
    required.push([`binaries/${platformDir}/whisper-libs`, { directory: true }]);
  }

  const missing = [];
  for (const [rel, opts] of required) {
    const abs = join(REPO, rel);
    if (!existsSync(abs)) {
      missing.push(`${rel}: missing`);
      continue;
    }
    const st = statSync(abs);
    if (opts.directory) {
      if (!st.isDirectory()) missing.push(`${rel}: not a directory`);
      continue;
    }
    if (opts.executable && !isExecutable(abs)) {
      missing.push(`${rel}: not executable`);
    }
    if (opts.minBytes && st.size < opts.minBytes) {
      missing.push(`${rel}: too small (${st.size} bytes)`);
    }
  }

  if (missing.length === 0) {
    ok('local release inputs', `required ${platformDir} binaries and models exist`);
  } else {
    fail('local release inputs', missing.join('\n'));
  }
}

function checkElectronBuilderResources() {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let config;
  try {
    config = require(join(REPO, 'electron-builder.config.cjs'));
  } catch (err) {
    fail('electron-builder resources', `cannot load config: ${err.message}`);
    return;
  } finally {
    console.warn = originalWarn;
  }

  const resources = Array.isArray(config.extraResources) ? config.extraResources : [];
  const froms = new Set(resources.map((resource) => resource.from));
  const platformDir = `${process.platform}-${process.arch}`;
  const expected = [
    `binaries/${platformDir}/whisper-cli${EXE_SUFFIX}`,
    `binaries/${platformDir}/llama-server${EXE_SUFFIX}`,
    'binaries/models/ggml-base.bin',
    'binaries/models/silero_vad.onnx',
    'binaries/models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
    'binaries/models/diarization/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  ];
  if (process.platform === 'darwin') {
    expected.push(`binaries/${platformDir}/whisper-libs`);
  }

  const missing = expected.filter((rel) => !froms.has(rel));
  if (missing.length === 0) {
    ok('electron-builder resources', 'required local release inputs are included in extraResources');
  } else {
    fail('electron-builder resources', `missing extraResources entries:\n${missing.join('\n')}`);
  }

  if (warnings.length > 0) {
    warn('electron-builder warnings', warnings.join('\n'));
  }
}

checkPackageBasics();
checkBetterSqliteAbi();
checkAppBoundary();
checkSharedBoundary();
checkTrackedBinaries();
checkLocalReleaseInputs();
checkElectronBuilderResources();

for (const result of results) {
  const label = result.status === 'ok' ? 'OK  ' : result.status === 'warn' ? 'WARN' : 'FAIL';
  const detail = result.detail ? `: ${result.detail}` : '';
  console.log(`[${label}] ${result.name}${detail}`);
}

const counts = {
  ok: results.filter((r) => r.status === 'ok').length,
  warn: results.filter((r) => r.status === 'warn').length,
  fail: results.filter((r) => r.status === 'fail').length,
};

console.log(`\n[subcast:doctor] ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail`);
if (counts.fail > 0) process.exit(1);
