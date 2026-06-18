/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getVadSession,
  runVadFrame,
  VAD_FRAME_SAMPLES,
  VAD_STATE_SIZE,
  _resetVadSessionForTest,
} from '../vadSession';

const MODEL_PATH = join(process.cwd(), 'binaries/models/silero_vad.onnx');

// Gate every test on the model being present locally. CI / fresh
// clones run `pnpm fetch:silero-vad` (when wired in Task 1 of the full
// plan) before tests; until then a missing file just skips this suite.
const haveModel = existsSync(MODEL_PATH);
const itIfModel = haveModel ? it : it.skip;

describe('vadSession', () => {
  beforeAll(() => {
    if (!haveModel) {
      console.warn(`[vadSession.test] skipping — model missing at ${MODEL_PATH}`);
    }
  });

  afterEach(() => {
    _resetVadSessionForTest();
  });

  itIfModel('loads the session lazily and caches it', async () => {
    const s1 = await getVadSession();
    const s2 = await getVadSession();
    expect(s2).toBe(s1);
  });

  itIfModel('runVadFrame returns a probability in [0, 1] for silence', async () => {
    const s = await getVadSession();
    const pcm = new Float32Array(VAD_FRAME_SAMPLES); // all zeros = silence
    const h = new Float32Array(VAD_STATE_SIZE);
    const c = new Float32Array(VAD_STATE_SIZE);
    const r = await runVadFrame(s, pcm, h, c);
    expect(r.prob).toBeGreaterThanOrEqual(0);
    expect(r.prob).toBeLessThanOrEqual(1);
    // Silence should score very low (Silero produces ~0.04 in spike tests).
    expect(r.prob).toBeLessThan(0.2);
  });

  itIfModel('runVadFrame propagates state across calls (state diverges from zero)', async () => {
    const s = await getVadSession();
    const pcm = new Float32Array(VAD_FRAME_SAMPLES);
    // Fill with low-amplitude noise so the model has something to react to.
    for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() - 0.5) * 0.05;
    const h0 = new Float32Array(VAD_STATE_SIZE);
    const c0 = new Float32Array(VAD_STATE_SIZE);
    const r = await runVadFrame(s, pcm, h0, c0);
    // After one frame of non-zero input, recurrent state must change.
    const hMoved = Array.from(r.hNext).some((v) => v !== 0);
    const cMoved = Array.from(r.cNext).some((v) => v !== 0);
    expect(hMoved || cMoved).toBe(true);
  });

  itIfModel('runVadFrame rejects wrong-length input', async () => {
    const s = await getVadSession();
    const bad = new Float32Array(VAD_FRAME_SAMPLES - 1);
    const h = new Float32Array(VAD_STATE_SIZE);
    const c = new Float32Array(VAD_STATE_SIZE);
    await expect(runVadFrame(s, bad, h, c)).rejects.toThrow(/expected/);
  });
});
