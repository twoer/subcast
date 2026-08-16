#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fetch the SenseVoice-Small (int8) model into binaries/models/sensevoice/
 * so dev-mode Nitro can run the sensevoice transcribe engine, and so the
 * desktop app's on-demand installer has a local copy to test against.
 *
 * Two files land in binaries/models/sensevoice/:
 *   model.int8.onnx — SenseVoice-Small int8 (~247 MB)
 *   tokens.txt      — tokenizer vocabulary
 *
 * Source: k2-fsa/sherpa-onnx GitHub release `asr-models`, int8-only
 * archive (~166 MB — the combined archive also carries a ~900 MB fp32
 * model we don't want). Mirrors fetch-diarize-models.mjs: CN proxy +
 * size checks, hashes not pinned (k2-fsa rotates snapshots).
 *
 * Idempotent — re-runs are no-ops when both files exist with expected size.
 */

import { createWriteStream, existsSync, statSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { fetchWithTimeout } from './_fetchWithTimeout.mjs';

const REPO = process.cwd();
const DEST = join(REPO, 'binaries', 'models', 'sensevoice');

const USE_PROXY = process.env.SUBCAST_GH_MIRROR !== 'direct';
const PROXY = USE_PROXY ? 'https://gh-proxy.com/' : '';
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const ARCHIVE_URL = `${PROXY}${GH}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2`;

const MODEL_FILE = join(DEST, 'model.int8.onnx');
const TOKENS_FILE = join(DEST, 'tokens.txt');
const MIN_MODEL_BYTES = 200_000_000;   // ~247 MB expected
const MIN_TOKENS_BYTES = 100_000;      // ~800 KB expected

function alreadyFetched() {
  if (!existsSync(MODEL_FILE) || !existsSync(TOKENS_FILE)) return false;
  return statSync(MODEL_FILE).size >= MIN_MODEL_BYTES && statSync(TOKENS_FILE).size >= MIN_TOKENS_BYTES;
}

if (alreadyFetched()) {
  console.log('[fetch-sensevoice] model.int8.onnx + tokens.txt already present — skipping');
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.error('[fetch-sensevoice] model missing — run without --check to download');
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });
const stage = join(DEST, '.stage');
await rm(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const archivePath = join(stage, 'sensevoice.tar.bz2');
console.log(`[fetch-sensevoice] downloading ${ARCHIVE_URL}`);
const res = await fetchWithTimeout(ARCHIVE_URL);
if (!res.ok || !res.body) {
  console.error(`[fetch-sensevoice] HTTP ${res.status} for ${ARCHIVE_URL}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
const total = Number(res.headers.get('content-length') ?? 0);
let downloaded = 0;
let lastLog = 0;
const body = Readable.fromWeb(res.body);
body.on('data', (chunk) => {
  downloaded += chunk.length;
  const now = Date.now();
  if (now - lastLog > 500) {
    lastLog = now;
    const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?';
    process.stdout.write(`\r[fetch-sensevoice] ${(downloaded / 1e6).toFixed(1)} MB${total ? ` / ${(total / 1e6).toFixed(1)} MB (${pct}%)` : ''}`);
  }
});
try {
  await pipeline(body, createWriteStream(archivePath));
} catch (err) {
  process.stdout.write('\n');
  console.error(`[fetch-sensevoice] download failed: ${err.message}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
process.stdout.write('\n');

const actualBytes = statSync(archivePath).size;
if (total && actualBytes !== total) {
  console.error(`[fetch-sensevoice] truncated: ${actualBytes} of ${total} bytes`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

// Extract just the two files we need from the nested tar.bz2.
console.log('[fetch-sensevoice] extracting model.int8.onnx + tokens.txt');
try {
  execFileSync('tar', ['-xjf', archivePath, '-C', stage], { stdio: 'inherit' });
} catch (err) {
  console.error(`[fetch-sensevoice] extract failed: ${err.message}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
function findIn(root, name) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      const hit = findIn(full, name);
      if (hit) return hit;
    } else if (e.name === name) return full;
  }
  return null;
}
const model = findIn(stage, 'model.int8.onnx');
const tokens = findIn(stage, 'tokens.txt');
if (!model || !tokens) {
  console.error('[fetch-sensevoice] model.int8.onnx / tokens.txt not found inside archive');
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
if (statSync(model).size < MIN_MODEL_BYTES) {
  console.error(`[fetch-sensevoice] model too small: ${statSync(model).size} bytes (< ${MIN_MODEL_BYTES})`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

await rename(model, MODEL_FILE);
await rename(tokens, TOKENS_FILE);
await rm(stage, { recursive: true, force: true });
console.log(`[fetch-sensevoice] saved ${MODEL_FILE} (${(statSync(MODEL_FILE).size / 1e6).toFixed(1)} MB) + tokens.txt`);
