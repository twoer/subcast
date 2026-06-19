#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fetch llama-server binary from llama.cpp's upstream GitHub Releases
 * into binaries/<plat>-<arch>/llama-server[.exe] so electron-builder
 * can bundle it via extraResources.
 *
 * Source of truth: github.com/ggml-org/llama.cpp/releases/tag/<LLAMA_CPP_VERSION>.
 * Upstream publishes per-platform zips (`llama-bN-bin-macos-arm64.zip`,
 * `llama-bN-bin-win-avx2-x64.zip`, etc.) — we download, extract the
 * single `llama-server` / `llama-server.exe` from inside, and discard
 * the rest. No intermediate Subcast-binaries mirror required.
 *
 * Versions are pinned via LLAMA_CPP_VERSION — keep it in sync with
 * .github/workflows/build-llama-server.yml's env block.
 *
 * Idempotent: skips when an existing binary is the expected size.
 */

import { createWriteStream, existsSync, statSync, chmodSync, mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { fetchWithTimeout } from './_fetchWithTimeout.mjs';

const LLAMA_CPP_VERSION = 'b4524';
const REPO = process.cwd();

// Upstream release-asset filenames. Windows AVX2 build is the right
// baseline for v1 (broad CPU support, no GPU dependencies). Switch the
// win32-x64 entry to `cuda-cu12.4` later if/when we ship a GPU variant.
const ASSETS = {
  'darwin-arm64': `llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.zip`,
  'darwin-x64':   `llama-${LLAMA_CPP_VERSION}-bin-macos-x64.zip`,
  'win32-x64':    `llama-${LLAMA_CPP_VERSION}-bin-win-avx2-x64.zip`,
};
// CN-friendly GitHub proxy. Direct github.com release downloads are
// often <50 KB/s without a proxy; gh-proxy.com routes through a CN
// CDN. Override with SUBCAST_GH_MIRROR=https://your-proxy or
// SUBCAST_GH_MIRROR=direct (no proxy).
const GH_PROXY = (process.env.SUBCAST_GH_MIRROR === 'direct' || !process.env.SUBCAST_GH_MIRROR)
  ? 'https://gh-proxy.com'
  : process.env.SUBCAST_GH_MIRROR.replace(/\/+$/, '');
const GH_DIRECT = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`;
const URL_BASE = process.env.SUBCAST_GH_MIRROR === 'direct'
  ? GH_DIRECT
  : `${GH_PROXY}/${GH_DIRECT}`;
const MIN_BYTES = 1 * 1024 * 1024;   // packed llama-server is ~5MB; allow margin
const MAX_BYTES = 80 * 1024 * 1024;

const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `${process.platform}-${process.arch}`;
const assetName = ASSETS[target];
if (!assetName) {
  console.error(`[fetch-llama-server] no asset mapping for ${target}; supported: ${Object.keys(ASSETS).join(', ')}`);
  process.exit(1);
}
const url = `${URL_BASE}/${assetName}`;

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

// Download the zip to a temp dir, then extract just llama-server.
const stage = mkdtempSync(join(tmpdir(), 'subcast-llama-fetch-'));
const zipPath = join(stage, assetName);

console.log(`[fetch-llama-server] downloading from ${url}`);
const res = await fetchWithTimeout(url);
if (!res.ok || !res.body) {
  console.error(`[fetch-llama-server] HTTP ${res.status} ${res.statusText} for ${url}`);
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
    process.stdout.write(
      `\r[fetch-llama-server] ${(downloaded / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)` : ''}`,
    );
  }
});

try {
  await pipeline(body, createWriteStream(zipPath));
} catch (err) {
  process.stdout.write('\n');
  console.error(`[fetch-llama-server] download failed: ${err.message}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
process.stdout.write('\n');

// Integrity check: verify the downloaded zip is complete. The previous
// build produced a truncated llama-server (3.5 MB vs the expected ~5.8 MB
// on mac arm64) because this script had NO size verification — a dropped
// connection left a partial zip, which unzipped into a broken binary that
// spawned but immediately died, surfacing at runtime as 'llama-server did
// not announce listening port within 30000ms'. Fail the build here instead.
const actualBytes = statSync(zipPath).size;
if (total && actualBytes !== total) {
  rmSync(stage, { recursive: true, force: true });
  console.error(
    `[fetch-llama-server] download truncated: got ${actualBytes} bytes, server advertised ${total}. ` +
      `Re-run; if it persists the upstream asset may be corrupt.`,
  );
  process.exit(1);
}
// Even without content-length, a llama.cpp release zip is always > 5 MB.
// Reject anything implausibly small (covers the no-content-length case).
const MIN_PLAUSIBLE_ZIP = 5_000_000;
if (actualBytes < MIN_PLAUSIBLE_ZIP) {
  rmSync(stage, { recursive: true, force: true });
  console.error(
    `[fetch-llama-server] download too small: ${actualBytes} bytes (< ${MIN_PLAUSIBLE_ZIP}). Likely truncated; aborting.`,
  );
  process.exit(1);
}
console.log(`[fetch-llama-server] download complete: ${actualBytes} bytes`);

// Extract the zip. macOS / Linux have `unzip` preinstalled; Windows
// has `tar -xf` (which speaks zip) since Windows 10 1803.
console.log(`[fetch-llama-server] extracting ${assetName}`);
try {
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zipPath, '-C', stage], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', stage], { stdio: 'inherit' });
  }
} catch (err) {
  console.error(`[fetch-llama-server] extract failed: ${err.message}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

// Find llama-server inside the staged directory. Upstream layout
// varies a bit between platforms (`build/bin/llama-server` on macOS,
// flat `llama-server.exe` on Windows). Walk the tree to find it.
function findBinary(root, name) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      const hit = findBinary(full, name);
      if (hit) return hit;
    } else if (e.isFile() && e.name === name) {
      return full;
    }
  }
  return null;
}

const wantedName = `llama-server${ext}`;
const found = findBinary(stage, wantedName);
if (!found) {
  console.error(`[fetch-llama-server] ${wantedName} not found inside ${assetName}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

const size = statSync(found).size;
if (size < MIN_BYTES || size > MAX_BYTES) {
  console.error(`[fetch-llama-server] extracted ${wantedName} size ${size}B outside [${MIN_BYTES}, ${MAX_BYTES}] — likely corrupt`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

const tmpDest = `${dest}.partial`;
await rm(tmpDest, { force: true });
copyFileSync(found, tmpDest);
await rename(tmpDest, dest);
chmodSync(dest, 0o755);
rmSync(stage, { recursive: true, force: true });
console.log(`[fetch-llama-server] saved to ${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`);
