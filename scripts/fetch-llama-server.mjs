#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Fetch llama-server binary from a Subcast-mirrored GitHub Release into
 * binaries/<plat>-<arch>/llama-server[.exe] so electron-builder can
 * bundle it via extraResources.
 *
 * Versions are pinned via the LLAMA_CPP_VERSION constant — bump when
 * intentionally upgrading. The script is idempotent: it skips download
 * if a binary already exists and is the expected size.
 *
 * Source: artifacts uploaded by .github/workflows/build-llama-server.yml.
 * Until those are published to a Releases page on the Subcast-binaries
 * repo, the URLs below will 404 — see binaries/README.md for the
 * intended publish workflow.
 */

import { createWriteStream, existsSync, statSync, chmodSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';

const LLAMA_CPP_VERSION = 'b4524';
const REPO = process.cwd();

const URLS = {
  'darwin-arm64': `https://github.com/twoer/subcast-binaries/releases/download/${LLAMA_CPP_VERSION}/llama-server-macos-arm64`,
  'win32-x64': `https://github.com/twoer/subcast-binaries/releases/download/${LLAMA_CPP_VERSION}/llama-server-windows-x64.exe`,
};
const MIN_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = 80 * 1024 * 1024;

const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `${process.platform}-${process.arch}`;
const url = URLS[target];
if (!url) {
  console.error(`[fetch-llama-server] no URL for ${target}; supported: ${Object.keys(URLS).join(', ')}`);
  process.exit(1);
}

const FORCE = process.argv.includes('--force');
const ext = target.startsWith('win32') ? '.exe' : '';
const dest = join(REPO, 'binaries', target, `llama-server${ext}`);

if (!FORCE && existsSync(dest)) {
  const size = statSync(dest).size;
  if (size >= MIN_BYTES && size <= MAX_BYTES) {
    console.log(`[fetch-llama-server] already present (${(size / 1024 / 1024).toFixed(1)} MB) at ${dest} — skipping. Pass --force to re-download.`);
    process.exit(0);
  }
}

await mkdir(dirname(dest), { recursive: true });
const tmp = `${dest}.partial`;
await rm(tmp, { force: true });

console.log(`[fetch-llama-server] downloading from ${url}`);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok || !res.body) {
  console.error(`[fetch-llama-server] HTTP ${res.status} ${res.statusText}`);
  console.error('  hint: Until the Subcast-binaries Release page exists, run the CI workflow manually and download the artifact, then publish it as a Release named after LLAMA_CPP_VERSION.');
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
    process.stdout.write(
      `\r[fetch-llama-server] ${(downloaded / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)` : ''}`,
    );
  }
});

try {
  await pipeline(body, createWriteStream(tmp));
} catch (err) {
  process.stdout.write('\n');
  console.error(`[fetch-llama-server] download failed: ${err.message}`);
  await rm(tmp, { force: true });
  process.exit(1);
}
process.stdout.write('\n');

const size = statSync(tmp).size;
if (size < MIN_BYTES || size > MAX_BYTES) {
  console.error(`[fetch-llama-server] downloaded size ${size}B outside [${MIN_BYTES}, ${MAX_BYTES}] — discarding.`);
  await rm(tmp);
  process.exit(1);
}

await rename(tmp, dest);
chmodSync(dest, 0o755);
console.log(`[fetch-llama-server] saved to ${dest}`);
