#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Phase 0 spike for speaker diarization (docs/diarization-plan.md v1.3).
 *
 * What this script verifies (one shot):
 *   1. sherpa-onnx-node prebuilt loads on current platform
 *   2. k2-fsa model pack downloads + extracts cleanly
 *   3. OfflineSpeakerDiarization processes a known wav end-to-end
 *   4. Output sanity: segments are time-ordered, speakers >= 1
 *
 * Not in scope:
 *   - electron-builder packaging (separate manual step)
 *   - 1h video perf measurement (run separately with your own wav)
 *   - LICENSE audit (open the extracted folder by hand)
 *
 * Models / test wav download to .cache/diarize-spike/ (gitignored).
 * Results print to stdout + write to docs/audits/diarization-spike-2026-05.json
 * (also gitignored — manual audit notes go in the .md sibling).
 *
 * Usage:
 *   node scripts/spike-diarize.mjs              # bundled 4-speaker zh test wav, auto-K
 *   node scripts/spike-diarize.mjs --k=4        # explicit speaker count
 *   node scripts/spike-diarize.mjs --threshold=0.7  # raise auto-K threshold
 *   node scripts/spike-diarize.mjs path/to.wav --k=2
 */

import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';

const REPO = process.cwd();
const CACHE = join(REPO, '.cache', 'diarize-spike');

// CN-friendly proxy, mirroring fetch-llama-server.mjs convention.
// Override with SUBCAST_GH_MIRROR=direct to disable.
const USE_PROXY = process.env.SUBCAST_GH_MIRROR !== 'direct';
const PROXY = USE_PROXY ? 'https://gh-proxy.com/' : '';

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const URLS = {
  segmentation: `${PROXY}${GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
  embedding:    `${PROXY}${GH}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`,
  testWav:      `${PROXY}${GH}/speaker-segmentation-models/0-four-speakers-zh.wav`,
};

const FILES = {
  segmentationTar:  join(CACHE, 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'),
  segmentationDir:  join(CACHE, 'sherpa-onnx-pyannote-segmentation-3-0'),
  segmentationOnnx: join(CACHE, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'),
  embeddingOnnx:    join(CACHE, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
  testWav:          join(CACHE, '0-four-speakers-zh.wav'),
};

// Parse CLI args. First non-flag arg is wav path; --k=N / --threshold=F are flags.
let userWav;
let argK = -1;          // -1 = sherpa-onnx auto-detect
let argThreshold = 0.5; // sherpa default
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--k=')) argK = parseInt(arg.slice(4), 10);
  else if (arg.startsWith('--threshold=')) argThreshold = parseFloat(arg.slice(12));
  else if (!arg.startsWith('--')) userWav = arg;
}
const wavToUse = userWav ?? FILES.testWav;

function log(...args) {
  console.log('[spike-diarize]', ...args);
}

async function downloadIfMissing(url, dest, label) {
  if (existsSync(dest)) {
    log(`✓ ${label} cached at ${dest} (${statSync(dest).size} bytes)`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  await rm(tmp, { force: true });
  log(`↓ ${label} ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const out = createWriteStream(tmp);
  let bytes = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { bytes += c.length; });
  await pipeline(body, out);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, dest);
  log(`✓ ${label} saved (${bytes} bytes)`);
}

function extractTarBz2(archive, intoDir) {
  if (existsSync(FILES.segmentationOnnx)) {
    log(`✓ segmentation already extracted at ${FILES.segmentationDir}`);
    return;
  }
  log(`⇉ extracting ${basename(archive)}`);
  // -C extracts INTO intoDir; the archive contains a top-level
  // sherpa-onnx-pyannote-segmentation-3-0/ folder, so we extract into CACHE.
  execFileSync('tar', ['-xjf', archive, '-C', intoDir], { stdio: 'inherit' });
  if (!existsSync(FILES.segmentationOnnx)) {
    throw new Error(`extract succeeded but ${FILES.segmentationOnnx} missing — pack layout changed?`);
  }
  log(`✓ extracted to ${FILES.segmentationDir}`);
}

async function main() {
  mkdirSync(CACHE, { recursive: true });

  // 1. Verify sherpa-onnx-node loads
  log('loading sherpa-onnx-node …');
  const mod = await import('sherpa-onnx-node');
  // sherpa-onnx-node is CJS; ESM import wraps named exports under .default
  const sherpa = mod.default ?? mod;
  if (typeof sherpa.OfflineSpeakerDiarization !== 'function') {
    throw new Error(`sherpa-onnx-node loaded but OfflineSpeakerDiarization missing; mod keys: ${Object.keys(mod).join(', ')}; sherpa keys: ${Object.keys(sherpa).join(', ')}`);
  }
  log(`✓ sherpa-onnx-node v${sherpa.version ?? 'unknown'} loaded`);

  // 2. Download model pack + test wav
  await downloadIfMissing(URLS.segmentation, FILES.segmentationTar, 'segmentation tar.bz2');
  extractTarBz2(FILES.segmentationTar, CACHE);
  await downloadIfMissing(URLS.embedding, FILES.embeddingOnnx, 'embedding model');
  if (!userWav) {
    await downloadIfMissing(URLS.testWav, FILES.testWav, 'test wav (4 speakers zh)');
  } else if (!existsSync(userWav)) {
    throw new Error(`user-provided wav not found: ${userWav}`);
  }

  // 3. Construct diarization session
  const config = {
    segmentation: {
      pyannote: { model: FILES.segmentationOnnx },
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    embedding: {
      model: FILES.embeddingOnnx,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    clustering: {
      numClusters: argK,        // -1 = auto-detect, or pinned via --k=N
      threshold: argThreshold,  // ignored when numClusters > 0
    },
    // Python example uses 0.3 (offline-speaker-diarization.py); Node example
    // uses 0.2 (test_offline_speaker_diarization.js). Difference of ~100ms only
    // affects whether very short "嗯"/"对" turns survive — choose 0.3 to match
    // the more documentation-heavy Python example.
    minDurationOn:  0.3,
    minDurationOff: 0.5,
  };

  log('constructing OfflineSpeakerDiarization …');
  const constructStartedAt = Date.now();
  const sd = new sherpa.OfflineSpeakerDiarization(config);
  const constructMs = Date.now() - constructStartedAt;
  log(`✓ constructed in ${constructMs} ms (expected sample rate: ${sd.sampleRate} Hz)`);

  // 4. Read wav
  log(`reading wav: ${wavToUse}`);
  const wave = sherpa.readWave(wavToUse);
  log(`✓ wav loaded: ${wave.samples.length} samples @ ${wave.sampleRate} Hz (${(wave.samples.length / wave.sampleRate).toFixed(2)} s)`);

  if (wave.sampleRate !== sd.sampleRate) {
    throw new Error(
      `sample rate mismatch: wav is ${wave.sampleRate} Hz, sherpa expects ${sd.sampleRate} Hz. ` +
      `Pre-process via ffmpeg -ar ${sd.sampleRate}.`,
    );
  }

  // 5. Run process()
  log('running diarization … (this is a sync C++ call, no progress)');
  const processStartedAt = Date.now();
  const segments = sd.process(wave.samples);
  const processMs = Date.now() - processStartedAt;
  log(`✓ done in ${processMs} ms`);

  // 6. Sanity checks
  const audioDurationS = wave.samples.length / wave.sampleRate;
  const realtimeFactor = (processMs / 1000) / audioDurationS;
  const speakerIds = [...new Set(segments.map((s) => s.speaker))].sort((a, b) => a - b);

  // ordering check
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].start) {
      throw new Error(`segments not time-ordered at index ${i}`);
    }
  }

  // 7. Print summary
  console.log('\n========== Spike Result ==========');
  console.log(`Wav:              ${basename(wavToUse)}`);
  console.log(`Duration:         ${audioDurationS.toFixed(2)} s`);
  console.log(`Sample rate:      ${wave.sampleRate} Hz`);
  console.log(`Construct time:   ${constructMs} ms`);
  console.log(`Process time:     ${processMs} ms (${realtimeFactor.toFixed(3)}× realtime)`);
  console.log(`Segments:         ${segments.length}`);
  console.log(`Speakers found:   ${speakerIds.length} (ids: [${speakerIds.join(', ')}])`);
  console.log('');
  console.log('First 8 segments:');
  for (const seg of segments.slice(0, 8)) {
    console.log(
      `  speaker ${seg.speaker}  ${seg.start.toFixed(2).padStart(7)}s → ${seg.end.toFixed(2).padStart(7)}s`,
    );
  }
  if (segments.length > 8) console.log(`  … ${segments.length - 8} more`);

  // 8. Dump JSON for the audit report
  const auditDir = join(REPO, 'docs', 'audits');
  mkdirSync(auditDir, { recursive: true });
  const jsonOut = join(auditDir, 'diarization-spike-2026-05.json');
  const auditData = {
    runAt: new Date().toISOString(),
    sherpaVersion: sherpa.version ?? 'unknown',
    wav: basename(wavToUse),
    audioDurationS,
    sampleRate: wave.sampleRate,
    constructMs,
    processMs,
    realtimeFactor,
    numSegments: segments.length,
    numSpeakers: speakerIds.length,
    speakerIds,
    segments: segments.map((s) => ({
      start: +s.start.toFixed(3),
      end: +s.end.toFixed(3),
      speaker: s.speaker,
    })),
    config: {
      clustering: config.clustering,
      minDurationOn: config.minDurationOn,
      minDurationOff: config.minDurationOff,
    },
  };
  writeFileSync(jsonOut, JSON.stringify(auditData, null, 2));
  console.log(`\nJSON dumped to ${jsonOut}`);
  console.log('Fill in qualitative observations in docs/audits/diarization-spike-2026-05.md');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error('[spike-diarize] FAILED:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
