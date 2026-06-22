#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fetch the standalone yt-dlp binary from yt-dlp's GitHub Releases into
 * binaries/<plat>-<arch>/yt-dlp[.exe] so electron-builder can bundle it
 * via extraResources.
 *
 * Unlike fetch-llama-server.mjs, yt-dlp publishes *standalone* executables
 * (not zips), so there is no extract step — the downloaded bytes ARE the
 * binary. We shell out to `curl` rather than Node's fetch because the
 * GitHub release CDN over this build network drops the trailing few KB
 * of every stream; curl's `-C -` resume + `--retry` recovers cleanly,
 * while Node fetch's single-shot stream silently truncates. curl ships
 * preinstalled on macOS / Linux / Windows 10+.
 *
 * Asset mapping (per yt-dlp 2026.x release naming):
 *   darwin-arm64  -> yt-dlp_macos      (universal2 binary, covers arm64+x64)
 *   darwin-x64    -> yt-dlp_macos      (same universal2 binary)
 *   win32-x64     -> yt-dlp.exe
 *
 * Version is pinned via YT_DLP_VERSION. Idempotent: skips when an existing
 * binary is within the plausible size band.
 */

import { existsSync, statSync, chmodSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';

const YT_DLP_VERSION = '2026.06.09';
const REPO = process.cwd();

// yt-dlp release asset filenames per target platform.
const ASSETS = {
  // yt-dlp_macos is a universal2 standalone binary (arm64 + x64 in one).
  'darwin-arm64': 'yt-dlp_macos',
  'darwin-x64': 'yt-dlp_macos',
  'win32-x64': 'yt-dlp.exe',
};
// CN-friendly GitHub proxy (same rationale as fetch-llama-server.mjs).
// Override with SUBCAST_GH_MIRROR=https://your-proxy or =direct.
const GH_PROXY = (process.env.SUBCAST_GH_MIRROR === 'direct' || !process.env.SUBCAST_GH_MIRROR)
  ? 'https://gh-proxy.com'
  : process.env.SUBCAST_GH_MIRROR.replace(/\/+$/, '');
const GH_DIRECT = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}`;
const URL_BASE = process.env.SUBCAST_GH_MIRROR === 'direct'
  ? GH_DIRECT
  : `${GH_PROXY}/${GH_DIRECT}`;

// yt-dlp_macos is ~35 MB; win .exe is ~17 MB. Plausibility band rejects
// a genuinely truncated download while tolerating CDN content-length drift.
const MIN_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = 80 * 1024 * 1024;

const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `${process.platform}-${process.arch}`;
const assetName = ASSETS[target];
if (!assetName) {
  console.error(`[fetch-yt-dlp] no asset mapping for ${target}; supported: ${Object.keys(ASSETS).join(', ')}`);
  process.exit(1);
}
const url = `${URL_BASE}/${assetName}`;

const FORCE = process.argv.includes('--force');
const ext = target.startsWith('win32') ? '.exe' : '';
const dest = join(REPO, 'binaries', target, `yt-dlp${ext}`);

if (!FORCE && existsSync(dest)) {
  const size = statSync(dest).size;
  if (size >= MIN_BYTES && size <= MAX_BYTES) {
    console.log(`[fetch-yt-dlp] already present (${(size / 1024 / 1024).toFixed(1)} MB) at ${dest} — skipping. Pass --force to re-download.`);
    process.exit(0);
  }
}

await mkdir(dirname(dest), { recursive: true });

// curl with retry + resume. `-C -` tells curl to resume from whatever
// bytes are already on disk, and `--retry 8` retries on transient
// failures (connection dropped, 5xx). This combination reliably
// completes 35 MB downloads where Node fetch truncated every attempt.
const tmpDest = `${dest}.partial`;
console.log(`[fetch-yt-dlp] downloading from ${url}`);
try {
  execFileSync('curl', [
    '-fL',                       // fail on HTTP error, follow redirects
    '--retry', '8',              // retry up to 8 times on transient errors
    '--retry-delay', '2',
    '-C', '-',                   // resume from partial file
    '-o', tmpDest,
    url,
  ], { stdio: 'inherit' });
} catch (err) {
  console.error(`[fetch-yt-dlp] curl failed: ${err.message}`);
  process.exit(1);
}

const actualBytes = statSync(tmpDest).size;
if (actualBytes < MIN_BYTES || actualBytes > MAX_BYTES) {
  console.error(
    `[fetch-yt-dlp] download size ${actualBytes}B outside [${MIN_BYTES}, ${MAX_BYTES}] — likely corrupt.`,
  );
  process.exit(1);
}
console.log(`[fetch-yt-dlp] download complete: ${actualBytes} bytes`);

renameSync(tmpDest, dest);
if (!target.startsWith('win32')) {
  chmodSync(dest, 0o755);
}
console.log(`[fetch-yt-dlp] saved to ${dest} (${(actualBytes / 1024 / 1024).toFixed(1)} MB)`);
