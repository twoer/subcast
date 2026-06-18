/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Source code for the diarization worker thread, embedded as a string.
 *
 * Why a string literal instead of a `.mjs` file: Nitro's Rollup output
 * doesn't natively handle `new Worker(new URL('./worker', import.meta.url))`
 * the way Vite client builds do — the URL resolves to a path inside
 * .output/server/chunks/ where no sibling worker file exists. Bundling
 * the source as a string side-steps the file-resolution problem
 * entirely; `new Worker(source, { eval: true })` parses it as CJS at
 * runtime. Trade-off: no syntax highlighting in IDEs, but the worker is
 * a stable ~120 lines that rarely changes.
 *
 * The worker runs sherpa-onnx-node's CPU-bound diarization off the main
 * thread (see rawDiarization.ts for the why). Worker is plain CJS so it
 * works under `eval: true` (which doesn't support ESM imports).
 */

export const DIARIZE_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort } = require('node:worker_threads');
const { createRequire } = require('node:module');

// sherpa-onnx-node lookup. eval-mode workers have __filename = '/[worker eval]',
// so plain require() walks up from '/' and never finds node_modules. The
// main thread passes its own import.meta.url (a file inside .output/server/
// in prod, or the dev source dir) so createRequire walks up from there
// and reaches .output/server/node_modules/sherpa-onnx-node/. The package
// itself is externalized in nuxt.config.ts so it's a regular sibling
// directory, not bundled into the chunk.
let sherpaInst = null;
function loadSherpa(callerURL) {
  if (sherpaInst) return sherpaInst;
  const req = createRequire(callerURL);
  const mod = req('sherpa-onnx-node');
  const api = mod.default || mod;
  if (typeof api.OfflineSpeakerDiarization !== 'function') {
    throw new Error(
      'sherpa-onnx-node loaded but OfflineSpeakerDiarization missing in worker — ' +
      'keys: ' + Object.keys(api).join(', '),
    );
  }
  sherpaInst = api;
  return api;
}

// Mirror chooseRepresentativeSegments from ./consolidate.ts. Inlined
// because the worker source can't import other TS files at runtime.
function chooseRepresentativeSegments(segments, maxSegments, minSeconds) {
  const durationS = (s) => (s.endMs - s.startMs) / 1000;
  return segments
    .slice()
    .filter((s) => durationS(s) >= minSeconds)
    .sort((a, b) => durationS(b) - durationS(a))
    .slice(0, maxSegments)
    .sort((a, b) => a.startMs - b.startMs);
}

function sliceSamples(buf, startMs, endMs, sr) {
  const startIdx = Math.max(0, Math.floor((startMs / 1000) * sr));
  const endIdx = Math.min(buf.length, Math.ceil((endMs / 1000) * sr));
  if (endIdx <= startIdx) return new Float32Array(0);
  // .slice() not .subarray(): sherpa rejects external buffer views.
  return buf.slice(startIdx, endIdx);
}

function averageVectors(vectors, dim) {
  const out = new Float32Array(dim);
  if (vectors.length === 0) return out;
  for (let vi = 0; vi < vectors.length; vi++) {
    const v = vectors[vi];
    for (let i = 0; i < dim; i++) out[i] += v[i] || 0;
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

// Single-message protocol: main thread sends one job, worker computes,
// posts one result, exits naturally. Wrapped in try/catch so errors
// flow back as ok:false rather than crashing the worker.
parentPort.once('message', (job) => {
  try {
    const {
      samples,
      sampleRate,
      segmentationModelPath,
      embeddingModelPath,
      numThreads,
      maxSegmentsPerSpeaker,
      minSegmentSeconds,
      callerURL,
    } = job;

    const sherpa = loadSherpa(callerURL);

    const processStart = Date.now();
    const sd = new sherpa.OfflineSpeakerDiarization({
      segmentation: {
        pyannote: { model: segmentationModelPath },
        numThreads,
        provider: 'cpu',
      },
      embedding: {
        model: embeddingModelPath,
        numThreads,
        provider: 'cpu',
      },
      clustering: { numClusters: -1, threshold: 1.0 },
      minDurationOn: 0.5,
      minDurationOff: 0.8,
    });

    if (sd.sampleRate !== sampleRate) {
      throw new Error(
        'wav sample rate ' + sampleRate + ' != sherpa expected ' + sd.sampleRate +
        '; extractWav output must be 16 kHz mono',
      );
    }

    const sherpaSegs = sd.process(samples);
    const processMs = Date.now() - processStart;

    const rawSegments = sherpaSegs
      .map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        rawSpeaker: s.speaker,
      }))
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    const byRaw = new Map();
    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i];
      const arr = byRaw.get(seg.rawSpeaker) || [];
      arr.push(seg);
      byRaw.set(seg.rawSpeaker, arr);
    }

    const embeddingStart = Date.now();
    const extractor = new sherpa.SpeakerEmbeddingExtractor({
      model: embeddingModelPath,
      numThreads,
      provider: 'cpu',
    });

    const rawSpeakers = [];
    for (const entry of byRaw) {
      const rawSpeaker = entry[0];
      const segs = entry[1];
      const reps = chooseRepresentativeSegments(segs, maxSegmentsPerSpeaker, minSegmentSeconds);
      if (reps.length === 0) continue;
      const vectors = [];
      for (let i = 0; i < reps.length; i++) {
        const rep = reps[i];
        const sliced = sliceSamples(samples, rep.startMs, rep.endMs, sampleRate);
        if (sliced.length === 0) continue;
        const stream = extractor.createStream();
        stream.acceptWaveform({ sampleRate, samples: sliced });
        stream.inputFinished();
        if (!extractor.isReady(stream)) continue;
        vectors.push(extractor.compute(stream, false));
      }
      if (vectors.length === 0) continue;
      const centroid = averageVectors(vectors, extractor.dim);
      let durationS = 0;
      for (let i = 0; i < segs.length; i++) durationS += (segs[i].endMs - segs[i].startMs) / 1000;
      rawSpeakers.push({ rawSpeaker, durationS, segmentCount: segs.length, centroid });
    }
    const embeddingMs = Date.now() - embeddingStart;

    const transferList = rawSpeakers.map((rs) => rs.centroid.buffer);
    parentPort.postMessage(
      {
        ok: true,
        rawSegments,
        rawSpeakers,
        processMs,
        embeddingMs,
        totalSamples: samples.length,
      },
      transferList,
    );
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined,
    });
  }
});
`;
