#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fetch diarization models into `binaries/models/diarization/` so
 * electron-builder bundles them via extraResources. Two files:
 *
 *   sherpa-onnx-pyannote-segmentation-3-0/model.onnx — speaker
 *     activity (pyannote-segmentation-3.0, MIT/CNRS). Comes packaged
 *     as a .tar.bz2 that includes README + LICENSE + the onnx file;
 *     we extract just the onnx into the canonical subdir.
 *
 *   3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx — speaker
 *     embedding (3D-Speaker campplus, Apache 2.0). Plain .onnx.
 *
 * Mirrors `scripts/fetch-silero-vad.mjs` in structure. CN proxy +
 * size check, hashes intentionally not pinned (k2-fsa rotates these
 * occasionally; pin via Phase 0 audit followup if integrity matters).
 *
 * Idempotent — re-runs are no-ops when files exist with expected size.
 */

import { createWriteStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { fetchWithTimeout } from './_fetchWithTimeout.mjs';

const REPO = process.cwd();
const DEST = join(REPO, 'binaries', 'models', 'diarization');

// CN proxy convention mirrors fetch-llama-server.mjs.
const USE_PROXY = process.env.SUBCAST_GH_MIRROR !== 'direct';
const PROXY = USE_PROXY ? 'https://gh-proxy.com/' : '';
const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

const ASSETS = [
  {
    label: 'segmentation pack (pyannote-3.0)',
    url: `${PROXY}${GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    archivePath: join(DEST, 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'),
    expectedFinalFile: join(DEST, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'),
    extract: true,
    expectedArchiveBytes: 6_958_444,
  },
  {
    label: 'campplus embedding model',
    url: `${PROXY}${GH}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`,
    archivePath: join(DEST, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'),
    expectedFinalFile: join(DEST, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'),
    extract: false,
    // ~27 MB — exact bytes vary across mirror snapshots, leave generous range.
    expectedArchiveMinBytes: 25_000_000,
  },
];

function log(...args) {
  console.log('[fetch-diarize-models]', ...args);
}

async function downloadIfMissing(asset) {
  if (existsSync(asset.expectedFinalFile)) {
    const size = statSync(asset.expectedFinalFile).size;
    log(`✓ ${asset.label} cached (${size} bytes)`);
    return;
  }
  mkdirSync(dirname(asset.archivePath), { recursive: true });
  const tmp = `${asset.archivePath}.partial`;
  await rm(tmp, { force: true });
  log(`↓ ${asset.label}  ${asset.url}`);
  const res = await fetchWithTimeout(asset.url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${asset.url}`);
  }
  let bytes = 0;
  const out = createWriteStream(tmp);
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { bytes += c.length; });
  await pipeline(body, out);
  if (asset.expectedArchiveBytes && bytes !== asset.expectedArchiveBytes) {
    log(`⚠ size mismatch on ${asset.label}: got ${bytes}, expected ${asset.expectedArchiveBytes}`);
  }
  if (asset.expectedArchiveMinBytes && bytes < asset.expectedArchiveMinBytes) {
    await rm(tmp, { force: true });
    throw new Error(`${asset.label} too small (${bytes} < ${asset.expectedArchiveMinBytes}); aborted`);
  }
  await rename(tmp, asset.archivePath);
  log(`✓ ${asset.label} downloaded (${bytes} bytes)`);
}

function extractIfNeeded(asset) {
  if (!asset.extract) return;
  if (existsSync(asset.expectedFinalFile)) {
    log(`✓ ${asset.label} already extracted`);
    return;
  }
  log(`⇉ extracting ${basename(asset.archivePath)}`);
  // 2 min cap: a 7 MB bzip2 should extract in seconds.
  //
  // Windows note: the windows-2022 runner's system `tar` (bsdtar) hangs
  // indefinitely on this particular tar.bz2 (observed in CI: stuck 25+ min
  // before manual cancel). 7-Zip is preinstalled on windows-*- runners, so
  // on Windows we extract in two 7z passes (bz2 → tar, tar → files) instead.
  // macOS/Linux keep using `tar -xjf` which works there.
  const EXTRACT_TIMEOUT_MS = 120_000;
  try {
    if (process.platform === 'win32') {
      // 7z extracts the bzip2 layer → produces the inner .tar in DEST.
      const innerTar = join(DEST, basename(asset.archivePath).replace(/\.bz2$/, ''));
      execFileSync('7z', ['x', '-y', `-o${DEST}`, asset.archivePath], {
        stdio: 'inherit',
        timeout: EXTRACT_TIMEOUT_MS,
      });
      // 7z extracts the tar layer → produces the final files.
      execFileSync('7z', ['x', '-y', `-o${DEST}`, innerTar], {
        stdio: 'inherit',
        timeout: EXTRACT_TIMEOUT_MS,
      });
    } else {
      execFileSync('tar', ['-xjf', asset.archivePath, '-C', DEST], {
        stdio: 'inherit',
        timeout: EXTRACT_TIMEOUT_MS,
      });
    }
  } catch (err) {
    throw new Error(
      `extract of ${basename(asset.archivePath)} failed/timed out: ${err.message}`,
    );
  }
  if (!existsSync(asset.expectedFinalFile)) {
    throw new Error(
      `extract succeeded but ${asset.expectedFinalFile} missing — pack layout changed?`,
    );
  }
}

async function main() {
  mkdirSync(DEST, { recursive: true });
  for (const asset of ASSETS) {
    await downloadIfMissing(asset);
    extractIfNeeded(asset);
  }
  log(`✓ all diarization models in ${DEST}`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error('[fetch-diarize-models] FAILED:', err.message);
  process.exit(1);
}
