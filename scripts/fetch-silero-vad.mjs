#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fetch silero_vad.onnx (v4.0) into binaries/models/ so electron-builder
 * can bundle it via extraResources. Pinned by SHA256 — refuse the
 * download if the hash drifts, since model bytes feed straight into
 * inference and a swapped file would silently corrupt every transcript.
 *
 * Re-pin EXPECTED_SHA only after manually verifying a new upstream
 * release via a second source (e.g. comparing against the official
 * pip-released `silero-vad` wheel).
 */
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchWithTimeout } from './_fetchWithTimeout.mjs';

const URL = 'https://github.com/snakers4/silero-vad/raw/refs/tags/v4.0/files/silero_vad.onnx';
const EXPECTED_SHA = 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28';
const EXPECTED_BYTES = 1807522;
const MAX_BYTES = 3 * 1024 * 1024;

const dest = join(process.cwd(), 'binaries', 'models', 'silero_vad.onnx');
if (existsSync(dest)) {
  const size = statSync(dest).size;
  if (size === EXPECTED_BYTES) {
    console.log(`[fetch-silero-vad] cached at ${dest} (${size} bytes)`);
    process.exit(0);
  }
  console.log(`[fetch-silero-vad] size mismatch (${size} vs ${EXPECTED_BYTES}), re-downloading`);
}

await mkdir(dirname(dest), { recursive: true });
const tmp = `${dest}.partial`;
await rm(tmp, { force: true });

console.log(`[fetch-silero-vad] downloading ${URL}`);
const res = await fetchWithTimeout(URL);
if (!res.ok || !res.body) {
  console.error(`[fetch-silero-vad] HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}

const hash = createHash('sha256');
let bytes = 0;
const out = createWriteStream(tmp);
const body = Readable.fromWeb(res.body);
body.on('data', (c) => {
  bytes += c.length;
  hash.update(c);
  if (bytes > MAX_BYTES) {
    body.destroy(new Error(`exceeded ${MAX_BYTES} bytes`));
  }
});
try {
  await pipeline(body, out);
} catch (err) {
  await rm(tmp, { force: true });
  console.error(`[fetch-silero-vad] download failed: ${err.message}`);
  process.exit(1);
}

const got = hash.digest('hex');
if (got !== EXPECTED_SHA) {
  await rm(tmp, { force: true });
  console.error(`[fetch-silero-vad] sha mismatch: got ${got}, expected ${EXPECTED_SHA}`);
  process.exit(1);
}
await rename(tmp, dest);
console.log(`[fetch-silero-vad] saved ${dest} (${bytes} bytes, sha256 ${got.slice(0, 12)}…)`);
