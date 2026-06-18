/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Lazy-init singleton wrapping the Silero VAD ONNX session. The first
 * `getVadSession()` call pays ~50 ms warm-up on M3 / ~80 ms on x64;
 * subsequent calls reuse the same session.
 *
 * Stateful inputs (RNN h/c) are reset per-audio inside the caller —
 * this module is concerned only with session lifecycle, not per-call
 * state.
 *
 * Model resolution mirrors `whisperPaths.ts`:
 *   - Desktop mode: `<SUBCAST_RESOURCES_PATH>/models/silero_vad.onnx`
 *     (electron-builder extraResources flattens to `Contents/Resources/models/...`)
 *   - Web / dev: `<cwd>/binaries/models/silero_vad.onnx`
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { logEvent } from './log';

const MODEL_FILENAME = 'silero_vad.onnx';

let session: InferenceSession | null = null;
let initPromise: Promise<InferenceSession> | null = null;

function modelPath(): string {
  const root = process.env.SUBCAST_RESOURCES_PATH;
  if (root) {
    // Desktop: extraResources lands under `<resourcesPath>/models/...`
    const desktopPath = join(root, 'models', MODEL_FILENAME);
    if (existsSync(desktopPath)) return desktopPath;
  }
  // Dev / web mode + fallback when desktop bundle path is missing.
  return join(process.cwd(), 'binaries', 'models', MODEL_FILENAME);
}

/**
 * Resolve (or initialize) the shared VAD session. Concurrent callers
 * during initialization all await the same promise — no double-init.
 */
export async function getVadSession(): Promise<InferenceSession> {
  if (session) return session;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const path = modelPath();
    if (!existsSync(path)) {
      throw new Error(`silero_vad.onnx not found at ${path}`);
    }
    const startedAt = Date.now();
    const s = await InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    logEvent({
      level: 'debug',
      event: 'vad_session_init',
      path,
      initMs: Date.now() - startedAt,
    });
    session = s;
    return s;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Test-only: drop the cached session. Lets vitest hand a fresh slate
 * to the next test without leaking the ONNX runtime's internal state.
 * Do not call from production code.
 */
export function _resetVadSessionForTest(): void {
  session = null;
  initPromise = null;
}

/** Shape of one Silero VAD frame's recurrent state (LSTM h or c). */
export const VAD_STATE_SIZE = 2 * 1 * 64;
/** Samples per 30 ms frame at the 16 kHz model sample rate. */
export const VAD_FRAME_SAMPLES = 480;

export interface VadFrameResult {
  prob: number;
  hNext: Float32Array<ArrayBufferLike>;
  cNext: Float32Array<ArrayBufferLike>;
}

/**
 * Run one Silero VAD frame through the session. Caller owns h/c state.
 * Returns updated state + speech probability for this frame.
 *
 * `pcm480` must be exactly `VAD_FRAME_SAMPLES` long; values are
 * normalized PCM in [-1, 1].
 */
export async function runVadFrame(
  s: InferenceSession,
  pcm480: Float32Array,
  h: Float32Array<ArrayBufferLike>,
  c: Float32Array<ArrayBufferLike>,
): Promise<VadFrameResult> {
  if (pcm480.length !== VAD_FRAME_SAMPLES) {
    throw new Error(`runVadFrame: expected ${VAD_FRAME_SAMPLES} samples, got ${pcm480.length}`);
  }
  const feed = {
    input: new Tensor('float32', pcm480, [1, VAD_FRAME_SAMPLES]),
    sr: new Tensor('int64', BigInt64Array.from([BigInt(16000)]), []),
    h: new Tensor('float32', h, [2, 1, 64]),
    c: new Tensor('float32', c, [2, 1, 64]),
  };
  const out = await s.run(feed);
  return {
    prob: (out.output!.data as Float32Array)[0]!,
    hNext: out.hn!.data as Float32Array,
    cNext: out.cn!.data as Float32Array,
  };
}
