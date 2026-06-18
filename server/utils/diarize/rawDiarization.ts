/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Stage 1 of the diarization pipeline (docs/diarization-plan.md v1.5).
 *
 * Calls sherpa-onnx's OfflineSpeakerDiarization on a prepared 16 kHz
 * mono wav and produces:
 *   1. Raw segments (potentially over-split — sherpa's own clustering is
 *      unreliable on long videos regardless of threshold; that's why we
 *      have Stage 2).
 *   2. Per-raw-speaker centroid embeddings extracted via sherpa's
 *      SpeakerEmbeddingExtractor over each raw speaker's representative
 *      segments. These are cached in diarize_raw_speakers so Stage 2 can
 *      run again (reconsolidate) without rerunning sherpa.
 *
 * v1.5 config (from user TECHNICAL_PLAN.md, validated):
 *   threshold       1.0    — high so raw stage doesn't try to converge
 *   numClusters    -1      — auto mode; we don't trust it for K, only
 *                            for raw shape
 *   minDurationOn   0.5    — drop segments shorter than this entirely
 *   minDurationOff  0.8    — merge same-speaker gaps shorter than this
 *
 * WAV loading note (v1.5 revision to Q1): we use `sherpa.readWave()`
 * instead of rolling our own s16→f32. Q1 originally planned to read
 * `extractWav()` output ourselves to match the VAD pipeline's
 * read-bytes-as-Float32 path. But sherpa-onnx-node ships readWave that
 * does exactly the same thing on the same file format (16 kHz mono
 * s16le), and avoiding duplicate WAV-parsing code is worth the minor
 * inconsistency.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  RawSegment,
} from '#shared/diarization';
import { CONSOLIDATE_DEFAULTS } from '#shared/diarization';
import { logEvent } from '../log';
import { readWavF32 } from './readWav';
import { DIARIZE_WORKER_SOURCE } from './diarizeWorkerSource';

// Side-effect import: the actual sherpa-onnx-node call happens inside
// the worker via createRequire(callerURL), but Nitro's externalize +
// dep-trace step only copies a package into .output/server/node_modules/
// if it sees a static import path to it. Without this line the package
// vanishes from the prod build and the worker hits
// "Cannot find module 'sherpa-onnx-node'" at runtime. Keeping this
// import also pulls in the optional platform binary (sherpa-onnx-
// darwin-arm64) as a sibling — which addon.js loads via the relative
// '../sherpa-onnx-darwin-arm64/sherpa-onnx.node' path.
import 'sherpa-onnx-node';

// Result envelope returned by diarizeWorkerSource.ts via postMessage.
// Keep the shape narrow — the worker is the only producer, callers
// here are the only consumer, so we don't bother exporting it.
interface WorkerOkResult {
  ok: true;
  rawSegments: RawSegment[];
  rawSpeakers: Array<{
    rawSpeaker: number;
    durationS: number;
    segmentCount: number;
    centroid: Float32Array;
  }>;
  processMs: number;
  embeddingMs: number;
  totalSamples: number;
}
interface WorkerErrResult { ok: false; error: string; stack?: string }
type WorkerResult = WorkerOkResult | WorkerErrResult;

/**
 * Resolve the per-platform path to the bundled diarization models.
 * Mirrors `silero_vad.onnx` resolution in vadSession.ts — desktop mode
 * goes through SUBCAST_RESOURCES_PATH, dev/web mode falls back to repo
 * binaries/.
 */
function modelDir(): string {
  const root = process.env.SUBCAST_RESOURCES_PATH;
  if (root) {
    const desktop = join(root, 'models', 'diarization');
    if (existsSync(desktop)) return desktop;
  }
  return join(process.cwd(), 'binaries', 'models', 'diarization');
}

const SEGMENTATION_FILE = 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx';
const EMBEDDING_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';

export function segmentationModelPath(): string {
  return join(modelDir(), SEGMENTATION_FILE);
}

export function embeddingModelPath(): string {
  return join(modelDir(), EMBEDDING_FILE);
}

function assertModelsExist(): void {
  const seg = segmentationModelPath();
  const emb = embeddingModelPath();
  if (!existsSync(seg)) {
    throw new Error(`diarize segmentation model missing: ${seg}. Run scripts/fetch-diarize-models.mjs`);
  }
  if (!existsSync(emb)) {
    throw new Error(`diarize embedding model missing: ${emb}. Run scripts/fetch-diarize-models.mjs`);
  }
}

export interface RawDiarizationResult {
  rawSegments: RawSegment[];
  /**
   * raw_speaker → centroid embedding (192-dim f32 for campplus).
   * Only includes raw speakers with at least one representative
   * segment ≥ minSegmentSeconds — skips raw speakers that are too
   * short to embed reliably. consolidate() handles missing centroids
   * by routing those raw speakers to 'unknown'.
   */
  rawSpeakers: Array<{
    rawSpeaker: number;
    durationS: number;
    segmentCount: number;
    centroid: Float32Array;
  }>;
  sampleRate: number;
  totalSamples: number;
  /** Wall-clock seconds for the sherpa.process() call only. */
  processMs: number;
  /** Wall-clock seconds for centroid extraction (all raw speakers combined). */
  embeddingMs: number;
}

export interface RawDiarizationOptions {
  /** Pass values from CONSOLIDATE_DEFAULTS by default. */
  maxSegmentsPerSpeaker?: number;
  minSegmentSeconds?: number;
  /** sherpa CPU threads for both segmentation and embedding. Default 2. */
  numThreads?: number;
}

/**
 * Run Stage 1 end-to-end on a pre-extracted 16 kHz mono wav file:
 *   1. Read wav samples via sherpa.readWave
 *   2. Run sherpa.OfflineSpeakerDiarization → raw segments
 *   3. For each raw speaker, pick representative segments + extract
 *      embeddings + average → centroid
 *
 * Throws if models aren't on disk (caller should ensure the model fetch
 * script ran first).
 */
export async function runRawDiarization(
  wavPath: string,
  opts: RawDiarizationOptions = {},
): Promise<RawDiarizationResult> {
  assertModelsExist();

  const numThreads = opts.numThreads ?? 2;
  const maxSegmentsPerSpeaker = opts.maxSegmentsPerSpeaker ?? CONSOLIDATE_DEFAULTS.maxSegmentsPerSpeaker;
  const minSegmentSeconds = opts.minSegmentSeconds ?? CONSOLIDATE_DEFAULTS.minSegmentSeconds;

  // Step 1 (main thread): load wav with our pure-JS reader. Disk I/O
  // is fast; doing it here avoids embedding parseWavF32 into the
  // worker source string. The samples Float32Array is then transferred
  // (zero-copy) to the worker.
  const wave = await readWavF32(wavPath);

  // Step 2 (worker thread): spawn the diarize worker, send the job,
  // await the result. sherpa.OfflineSpeakerDiarization.process and
  // SpeakerEmbeddingExtractor.compute are synchronous native ONNX
  // calls that would otherwise block the main event loop for minutes.
  const result = await runInWorker({
    samples: wave.samples,
    sampleRate: wave.sampleRate,
    segmentationModelPath: segmentationModelPath(),
    embeddingModelPath: embeddingModelPath(),
    numThreads,
    maxSegmentsPerSpeaker,
    minSegmentSeconds,
    callerURL: import.meta.url,
  });

  logEvent({
    level: 'debug',
    event: 'diarize_raw_done',
    rawSegmentCount: result.rawSegments.length,
    rawSpeakerCount: new Set(result.rawSegments.map((s) => s.rawSpeaker)).size,
    centroidCount: result.rawSpeakers.length,
    processMs: result.processMs,
    embeddingMs: result.embeddingMs,
  });

  return {
    rawSegments: result.rawSegments,
    rawSpeakers: result.rawSpeakers,
    sampleRate: wave.sampleRate,
    totalSamples: result.totalSamples,
    processMs: result.processMs,
    embeddingMs: result.embeddingMs,
  };
}

interface WorkerJob {
  samples: Float32Array;
  sampleRate: number;
  segmentationModelPath: string;
  embeddingModelPath: string;
  numThreads: number;
  maxSegmentsPerSpeaker: number;
  minSegmentSeconds: number;
  /**
   * Main thread's import.meta.url. Passed into the worker so
   * `createRequire(callerURL)('sherpa-onnx-node')` resolves from a
   * location inside .output/server/ (where the externalized package
   * actually lives), instead of from /[worker eval] (where eval-mode
   * workers run by default and require resolution fails).
   */
  callerURL: string;
}

/**
 * Spin up a one-shot worker, send a single job, await one result, and
 * terminate. The worker source lives in diarizeWorkerSource.ts and
 * runs as CJS under `eval: true` (no ESM imports inside the worker —
 * `new Worker(string, { eval: true })` parses the source as a classic
 * script). The samples Float32Array is moved to the worker via
 * transferList so the 230 MB hour-of-audio case is zero-copy.
 */
function runInWorker(job: WorkerJob): Promise<WorkerOkResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(DIARIZE_WORKER_SOURCE, { eval: true });
    let settled = false;
    const settle = (err: Error | null, ok?: WorkerOkResult): void => {
      if (settled) return;
      settled = true;
      // Detach listeners before terminate to avoid a stray exit-with-
      // error firing after we've already resolved.
      worker.removeAllListeners();
      void worker.terminate();
      if (err) reject(err);
      else if (ok) resolve(ok);
    };

    worker.on('message', (msg: WorkerResult) => {
      if (msg.ok) {
        // Centroids may arrive as plain ArrayBuffers depending on the
        // structured-clone path; coerce defensively.
        const coerced: WorkerOkResult = {
          ...msg,
          rawSpeakers: msg.rawSpeakers.map((rs) => ({
            ...rs,
            centroid: rs.centroid instanceof Float32Array
              ? rs.centroid
              : new Float32Array(rs.centroid as ArrayBufferLike),
          })),
        };
        settle(null, coerced);
      } else {
        const err = new Error(msg.error);
        if (msg.stack) err.stack = msg.stack;
        settle(err);
      }
    });
    worker.on('error', (err) => settle(err));
    worker.on('exit', (code) => {
      if (code !== 0) settle(new Error(`diarize worker exited with code ${code}`));
    });

    // Send the job. samples.buffer is transferred (zero-copy); after
    // this point the main thread's `job.samples` view is detached.
    // Cast: readWavF32 always allocates a fresh ArrayBuffer (never a
    // SharedArrayBuffer view), so it's safe to coerce here.
    worker.postMessage(job, [job.samples.buffer as ArrayBuffer]);
  });
}
