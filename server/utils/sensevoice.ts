/* SPDX-License-Identifier: Apache-2.0 */

/**
 * SenseVoice transcription engine (zh/en/ja/ko/yue) via sherpa-onnx-node.
 *
 * Companion to the whisper.cpp path — SenseVoice-Small is ~15x faster
 * than Whisper on CPU for CJK-heavy audio with comparable or better
 * Mandarin accuracy, but emits sentence-level text per inference window
 * (no word-level timestamps). We therefore align cues to VAD segments:
 * each planned speech segment becomes exactly one cue whose timestamps
 * are the segment bounds. See docs/plans/2026-08-15-model-upgrade-
 * qwen3-sensevoice.md Phase 2.
 *
 * Threading mirrors diarize/: the ONNX inference is CPU-bound, so it
 * runs in a worker thread whose source is embedded as a string (Nitro's
 * Rollup output can't resolve `new Worker(new URL(...))` — same
 * rationale as diarizeWorkerSource.ts). Unlike diarize's one-shot
 * worker, this one is long-lived: a transcription task recognizes
 * dozens of segments and reloading the ~240 MB model per segment
 * would dominate wall time.
 *
 * WAV loading reuses diarize/readWav.ts — sherpa's readWave trips
 * Node 22's strict N-API external-buffer rules.
 */

import { existsSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readWavF32, type Wave } from './diarize/readWav';
import type { Cue } from './vtt';
import type { ChunkPlan } from '#shared/chunking';

/** Files that must exist on disk for the engine to be usable. */
export const SENSE_VOICE_MODEL_FILE = 'model.int8.onnx';
export const SENSE_VOICE_TOKENS_FILE = 'tokens.txt';
/** int8 quantized SenseVoice-Small is ~247 MB; anything smaller is truncated. */
const MIN_MODEL_BYTES = 200_000_000;

/**
 * Model directory: desktop installs into `$SUBCAST_HOME/models/sensevoice`
 * (on-demand download, same layout as models/whisper); dev falls back to
 * the repo's binaries/ dir populated by scripts/fetch-sensevoice.mjs.
 */
export function senseVoiceModelDir(): string {
  const home = process.env.SUBCAST_HOME;
  if (home) return join(home, 'models', 'sensevoice');
  return join(process.cwd(), 'binaries', 'models', 'sensevoice');
}

export function senseVoiceModelPaths(): { model: string; tokens: string } {
  const dir = senseVoiceModelDir();
  return { model: join(dir, SENSE_VOICE_MODEL_FILE), tokens: join(dir, SENSE_VOICE_TOKENS_FILE) };
}

export function isSenseVoiceReady(): boolean {
  const { model, tokens } = senseVoiceModelPaths();
  if (!existsSync(model) || !existsSync(tokens)) return false;
  try {
    return statSync(model).size >= MIN_MODEL_BYTES;
  } catch {
    return false;
  }
}

/**
 * Worker source (plain CJS — `eval: true` workers can't use ESM).
 * Protocol: persistent, request/response with monotonically increasing
 * job ids so concurrent recognize() calls interleave safely.
 *   → { type: 'load', modelPath, tokensPath, callerURL, numThreads }
 *   ← { type: 'loaded' } | { type: 'error', error }
 *   → { type: 'recognize', id, samples, sampleRate }
 *   ← { type: 'result', id, text } | { type: 'error', id, error }
 *   → { type: 'dispose' }
 */
const SENSE_VOICE_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort } = require('node:worker_threads');
const { createRequire } = require('node:module');

let sherpaInst = null;
function loadSherpa(callerURL) {
  if (sherpaInst) return sherpaInst;
  const req = createRequire(callerURL);
  const mod = req('sherpa-onnx-node');
  const api = mod.default || mod;
  if (typeof api.OfflineRecognizer !== 'function') {
    throw new Error(
      'sherpa-onnx-node loaded but OfflineRecognizer missing in worker — ' +
      'keys: ' + Object.keys(api).join(', '),
    );
  }
  sherpaInst = api;
  return api;
}

let recognizer = null;
let recognizerSampleRate = 16000;

parentPort.on('message', (msg) => {
  if (msg.type === 'dispose') {
    parentPort.close();
    return;
  }
  if (msg.type === 'load') {
    try {
      const sherpa = loadSherpa(msg.callerURL);
      recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: msg.modelPath,
            // '' = auto language detection (zh/en/ja/ko/yue).
            language: '',
            useInverseTextNormalization: 1,
          },
          tokens: msg.tokensPath,
          numThreads: msg.numThreads || 2,
          provider: 'cpu',
          debug: 0,
        },
      });
      recognizerSampleRate = recognizer.config
        ? recognizer.config.featConfig.sampleRate
        : 16000;
      parentPort.postMessage({ type: 'loaded', sampleRate: recognizerSampleRate });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === 'setLanguage') {
    // Task-level language pin: the queue samples the first segments with
    // auto-detect, votes on the dominant script, then pins the language
    // for the whole task. Per-segment auto-detect flips on short/noisy
    // segments (e.g. "哦"/"麻雀" in English dispatch audio) and produces
    // mixed-language transcripts.
    try {
      if (!recognizer) throw new Error('recognizer not loaded');
      recognizer.setConfig({ language: msg.language });
      parentPort.postMessage({ type: 'languageSet', id: msg.id, language: msg.language });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        id: msg.id,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === 'recognize') {
    try {
      if (!recognizer) throw new Error('recognizer not loaded');
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: msg.sampleRate, samples: msg.samples });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      parentPort.postMessage({ type: 'result', id: msg.id, text: (result && result.text) || '' });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        id: msg.id,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
});
`;

interface LoadedEvent { type: 'loaded'; sampleRate: number }
interface ErrorEvent { type: 'error'; error: string; id?: number }
interface ResultEvent { type: 'result'; id: number; text: string }
interface LanguageSetEvent { type: 'languageSet'; id: number; language: string }
type WorkerEvent = LoadedEvent | ErrorEvent | ResultEvent | LanguageSetEvent | { type: string; [k: string]: unknown };

interface PendingJob {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/**
 * Long-lived worker session. Lazily spawned singleton via
 * `getSenseVoiceSession()`; the model loads once per process and stays
 * resident across tasks. `disposeSenseVoiceSession()` tears it down
 * (used by tests; production keeps it until process exit).
 */
export class SenseVoiceSession {
  private worker: Worker | null = null;
  private loaded: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingJob>();

  async ensure(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = new Promise<void>((resolve, reject) => {
      const { model, tokens } = senseVoiceModelPaths();
      if (!isSenseVoiceReady()) {
        this.loaded = null;
        reject(new Error('SENSE_VOICE_NOT_INSTALLED'));
        return;
      }
      let settled = false;
      const worker = new Worker(SENSE_VOICE_WORKER_SOURCE, { eval: true });
      this.worker = worker;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.worker = null;
        this.loaded = null;
        reject(err);
      };

      const dispatch = (ev: WorkerEvent) => {
        if (ev.type === 'loaded') {
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        if (ev.type !== 'result' && ev.type !== 'error' && ev.type !== 'languageSet') return;
        const typed = ev as ResultEvent | ErrorEvent | LanguageSetEvent;
        if (typed.id === undefined) {
          // id-less error = load-phase failure.
          fail(new Error(`sensevoice worker load failed: ${(typed as ErrorEvent).error}`));
          return;
        }
        const job = this.pending.get(typed.id);
        if (job) {
          this.pending.delete(typed.id);
          if (typed.type === 'result') job.resolve((typed as ResultEvent).text);
          else if (typed.type === 'languageSet') job.resolve((typed as LanguageSetEvent).language);
          else job.reject(new Error((typed as ErrorEvent).error));
        }
      };

      worker.on('message', dispatch);
      worker.once('exit', (code) => {
        // Reject everything still pending — worker died underneath us.
        for (const [, job] of this.pending) {
          job.reject(new Error(`sensevoice worker exited (${code})`));
        }
        this.pending.clear();
        this.worker = null;
        this.loaded = null;
        fail(new Error(`sensevoice worker exited before load (${code})`));
      });
      worker.once('error', (err) => {
        fail(err);
      });
      worker.postMessage({
        type: 'load',
        modelPath: model,
        tokensPath: tokens,
        // Resolves sherpa-onnx-node from the Nitro output dir (package is
        // externalized in nuxt.config.ts). import.meta.url points into the
        // bundle for prod and the source tree for dev.
        callerURL: fileURLToPath(import.meta.url),
        numThreads: senseVoiceThreads(),
      });
    });
    return this.loaded;
  }

  recognize(samples: Float32Array, sampleRate = 16_000): Promise<string> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('sensevoice worker not running'));
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Transfer the samples buffer — the queue is done with its copy.
      const copy = samples.slice();
      worker.postMessage({ type: 'recognize', id, samples: copy, sampleRate }, [copy.buffer]);
    });
  }

  /**
   * Pin the recognizer language for the rest of the process (task-level
   * lock against per-segment auto-detect flips). `language` is one of
   * 'zh' | 'en' | 'ja' | 'ko' | 'yue'.
   */
  setLanguage(language: string): Promise<string> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('sensevoice worker not running'));
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'setLanguage', id, language });
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.loaded = null;
    if (worker) {
      try { worker.postMessage({ type: 'dispose' }); } catch { /* already gone */ }
      await worker.terminate();
    }
    for (const [, job] of this.pending) job.reject(new Error('sensevoice session disposed'));
    this.pending.clear();
  }
}

let session: SenseVoiceSession | null = null;

export function getSenseVoiceSession(): SenseVoiceSession {
  if (!session) session = new SenseVoiceSession();
  return session;
}

export async function disposeSenseVoiceSession(): Promise<void> {
  if (session) await session.dispose();
  session = null;
}

/**
 * Per-process WAV cache. The queue transcribes chunk-by-chunk (for SSE
 * progress + resume), which would otherwise re-read the same ~230 MB
 * hour-long WAV once per chunk. Keyed by path + mtime so re-transcribing
 * a changed file can't serve stale samples.
 */
let wavCache: { path: string; mtimeMs: number; wave: Wave } | null = null;

/**
 * ONNX intra-op threads for the recognizer. Clamped: below 2 starves
 * the P-cluster on small machines, above 4 starts fighting llama-server
 * and the UI for cores without buying measurable decode time.
 */
function senseVoiceThreads(): number {
  const cores = cpus().length;
  return Math.max(2, Math.min(4, Math.floor(cores / 2)));
}

/**
 * Drop the cached WAV samples (~230MB per hour of audio as Float32).
 * Called when a transcribe task ends so the buffer doesn't stay
 * resident until the next task replaces it.
 */
export function releaseSenseVoiceWavCache(): void {
  wavCache = null;
}

function loadWavCached(path: string): Promise<Wave> {
  const mtimeMs = statSync(path).mtimeMs;
  if (wavCache && wavCache.path === path && wavCache.mtimeMs === mtimeMs) {
    return Promise.resolve(wavCache.wave);
  }
  return readWavF32(path).then((wave) => {
    wavCache = { path, mtimeMs, wave };
    return wave;
  });
}

// --- Text post-processing (pure, unit-tested) ------------------------------

/** SenseVoice emits `<|zh|>`/`<|NEUTRAL|>`-style control tokens on some
 *  model/runtime version combos — strip defensively before cues are used. */
export function stripSenseVoiceTags(text: string): string {
  return text.replace(/<\|[^|>]*\|>/g, '');
}

/**
 * SenseVoice outputs English in ALL CAPS (training-data artifact).
 * When a segment is letter-dominant and mostly uppercase, lowercase it
 * and sentence-case the result. CJK text passes through untouched.
 */
export function normalizeSenseVoiceCasing(text: string): string {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return text;
  const upper = text.replace(/[^A-Z]/g, '').length;
  if (upper / letters.length < 0.6) return text;
  const lowered = text.toLowerCase();
  // Capitalize the first letter and any letter after sentence enders.
  return lowered.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p1: string, p2: string) => p1 + p2.toUpperCase());
}

/** Dominant script of a recognition result → SenseVoice language id. */
export function detectDominantLanguage(text: string): 'zh' | 'ja' | 'ko' | 'en' | null {
  const cjkIdeographs = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (cjkIdeographs > 0) return 'zh';
  if (latin > 0) return 'en';
  return null;
}

/** Majority vote across sampled segment texts; null when inconclusive. */
export function voteLanguage(texts: string[]): 'zh' | 'ja' | 'ko' | 'en' | null {
  const tally = new Map<string, number>();
  for (const text of texts) {
    const lang = detectDominantLanguage(text);
    if (lang) tally.set(lang, (tally.get(lang) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [lang, count] of tally) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best as 'zh' | 'ja' | 'ko' | 'en' | null;
}

/**
 * Per-wav language pin (path + mtime keyed, mirrors wavCache). The first
 * task touching a wav samples its opening segments with auto-detect,
 * votes, then pins the recognizer for every later segment — per-segment
 * auto-detect flips on short/noisy segments and mixes languages inside
 * one transcript.
 */
let langPinCache: { path: string; mtimeMs: number; language: string } | null = null;

/**
 * Sample a wav's opening segments with SenseVoice and vote on the
 * dominant language. Used twice: (1) the queue's `auto` engine resolves
 * CJK-vs-English dispatch from it, (2) the sensevoice path pins the
 * recognizer language for the whole file. Pure sampling — does not pin
 * anything; cheap (3 × short segments) but result is cached per wav via
 * `langPinCache` when `pin` is true.
 */
export async function detectWavLanguage(
  wavPath: string,
  samplePlans: ChunkPlan[],
): Promise<'zh' | 'ja' | 'ko' | 'en' | null> {
  const { samples, sampleRate } = await loadWavCached(wavPath);
  const sv = getSenseVoiceSession();
  await sv.ensure();
  const sampleTexts: string[] = [];
  for (const plan of samplePlans.slice(0, 3)) {
    const startIdx = Math.max(0, Math.floor((plan.startMs / 1000) * sampleRate));
    const endIdx = Math.min(samples.length, Math.ceil((plan.endMs / 1000) * sampleRate));
    if (endIdx <= startIdx) continue;
    const text = await sv.recognize(samples.slice(startIdx, endIdx), sampleRate);
    if (text.trim()) sampleTexts.push(stripSenseVoiceTags(text));
  }
  return voteLanguage(sampleTexts);
}

export interface SenseVoiceTranscribeOptions {
  signal?: AbortSignal;
  /**
   * Language already resolved upstream (auto-dispatch / language pin):
   * pins the recognizer once per wav instead of re-sampling. Ignored
   * when the per-wav pin cache already holds a value for this wav.
   */
  pinLanguage?: 'zh' | 'ja' | 'ko' | 'en' | null;
  /**
   * Opening chunks to sample when neither a pin nor `pinLanguage` is
   * available (queue passes its first 3 plans on every chunk call).
   */
  samplePlans?: ChunkPlan[];
}

/**
 * Transcribe the planned speech segments of a 16 kHz mono WAV with
 * SenseVoice. One cue per segment (segment bounds are the cue bounds).
 * Returns [] when no segment produced text (silence-only audio).
 *
 * Pure engine call: chunk persistence, SSE emission, resume and
 * hallucination detection stay in transcribeQueue — SenseVoice has no
 * sampling temperature, so whisper's retry ladder doesn't apply.
 */
export async function transcribeSegmentsSenseVoice(
  wavPath: string,
  plans: ChunkPlan[],
  opts: SenseVoiceTranscribeOptions = {},
): Promise<Cue[]> {
  const { samples, sampleRate } = await loadWavCached(wavPath);
  const sv = getSenseVoiceSession();
  await sv.ensure();

  const mtimeMs = statSync(wavPath).mtimeMs;
  const pinValid =
    langPinCache !== null && langPinCache.path === wavPath && langPinCache.mtimeMs === mtimeMs;
  if (!pinValid) {
    let voted = opts.pinLanguage ?? null;
    if (!voted && opts.samplePlans && opts.samplePlans.length > 0) {
      const sampleTexts: string[] = [];
      for (const plan of opts.samplePlans.slice(0, 3)) {
        const startIdx = Math.max(0, Math.floor((plan.startMs / 1000) * sampleRate));
        const endIdx = Math.min(samples.length, Math.ceil((plan.endMs / 1000) * sampleRate));
        if (endIdx <= startIdx) continue;
        const text = await sv.recognize(samples.slice(startIdx, endIdx), sampleRate);
        if (text.trim()) sampleTexts.push(stripSenseVoiceTags(text));
      }
      voted = voteLanguage(sampleTexts);
    }
    if (voted) {
      try {
        await sv.setLanguage(voted);
        langPinCache = { path: wavPath, mtimeMs, language: voted };
      } catch {
        // setConfig unsupported on this runtime build — stay on auto.
      }
    }
  }

  const cues: Cue[] = [];
  for (const plan of plans) {
    const startIdx = Math.max(0, Math.floor((plan.startMs / 1000) * sampleRate));
    const endIdx = Math.min(samples.length, Math.ceil((plan.endMs / 1000) * sampleRate));
    if (endIdx <= startIdx) continue;
    // .slice() not .subarray(): sherpa rejects external buffer views.
    const slice = samples.slice(startIdx, endIdx);
    const raw = await sv.recognize(slice, sampleRate);
    const text = normalizeSenseVoiceCasing(stripSenseVoiceTags(raw)).trim();
    if (!text) continue;
    cues.push({ startMs: plan.startMs, endMs: plan.endMs, text });
  }
  return cues;
}
