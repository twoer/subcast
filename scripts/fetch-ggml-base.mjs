#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Fetch ggml-base.bin into binaries/models/ so electron-builder can
 * bundle it via extraResources (decision: ship a default model in the
 * DMG so first launch is offline-usable).
 *
 * Idempotent: if a file with a plausible size already exists at the
 * destination, the script exits 0 without touching the network. Force
 * a re-download with `--force` or by deleting the file first.
 *
 * Mirror selection:
 *   - default:           https://huggingface.co/ggerganov/whisper.cpp
 *   - SUBCAST_HF_MIRROR=hf-mirror   → https://hf-mirror.com/...
 *
 * This is a build-host helper, not a release-time fetch — CI should
 * cache the file outside of the repo. The blob is ~148 MB.
 */

import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';

const REPO = process.cwd();
const DEST = join(REPO, 'binaries', 'models', 'ggml-base.bin');

// Size range from desktop/modelManager/whisperScan.ts MODEL_META.base.
const MIN_BYTES = 130 * 1024 * 1024;
const MAX_BYTES = 170 * 1024 * 1024;

const MIRROR = process.env.SUBCAST_HF_MIRROR === 'hf-mirror'
  ? 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main'
  : 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const URL = `${MIRROR}/ggml-base.bin`;

const FORCE = process.argv.includes('--force');

function hasPlausibleFile(path) {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  return size >= MIN_BYTES && size <= MAX_BYTES;
}

if (!FORCE && hasPlausibleFile(DEST)) {
  const size = statSync(DEST).size;
  console.log(
    `[fetch-ggml-base] already present (${(size / 1024 / 1024).toFixed(1)} MB) at ${DEST} — skipping. Pass --force to re-download.`,
  );
  process.exit(0);
}

await mkdir(dirname(DEST), { recursive: true });

const tmp = `${DEST}.partial`;
await rm(tmp, { force: true });

console.log(`[fetch-ggml-base] downloading from ${URL}`);
const res = await fetch(URL);
if (!res.ok || !res.body) {
  console.error(`[fetch-ggml-base] HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}

const total = Number(res.headers.get('content-length') ?? 0);
let downloaded = 0;
let lastLog = 0;

const body = Readable.fromWeb(res.body);
body.on('data', (chunk) => {
  downloaded += chunk.length;
  const now = Date.now();
  if (now - lastLog > 1_000) {
    lastLog = now;
    const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?';
    process.stdout.write(
      `\r[fetch-ggml-base] ${(downloaded / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)` : ''}`,
    );
  }
});

try {
  await pipeline(body, createWriteStream(tmp));
} catch (err) {
  process.stdout.write('\n');
  console.error(`[fetch-ggml-base] download failed: ${err.message}`);
  await rm(tmp, { force: true });
  process.exit(1);
}
process.stdout.write('\n');

if (!hasPlausibleFile(tmp)) {
  const size = statSync(tmp).size;
  console.error(
    `[fetch-ggml-base] downloaded file size ${size} bytes is outside expected range [${MIN_BYTES}, ${MAX_BYTES}] — discarding.`,
  );
  await rm(tmp, { force: true });
  process.exit(1);
}

await rename(tmp, DEST);
console.log(`[fetch-ggml-base] saved to ${DEST}`);
