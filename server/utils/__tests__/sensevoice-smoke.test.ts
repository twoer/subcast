/* SPDX-License-Identifier: Apache-2.0 */

/**
 * End-to-end smoke test for the SenseVoice transcribe engine
 * (VAD segmentation → per-segment recognition → segment-level cues).
 *
 * Disabled by default — needs the SenseVoice model on disk (see
 * scripts/fetch-sensevoice.mjs) plus a real 16 kHz mono WAV. To run:
 *
 *   node scripts/fetch-sensevoice.mjs
 *   SUBCAST_SV_SMOKE_WAV=/path/to/16khz-mono.wav pnpm vitest run \
 *     server/utils/__tests__/sensevoice-smoke.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { detectSpeechSegments } from '../vad';
import { planChunksFromVad } from '#shared/chunking';
import { transcribeSegmentsSenseVoice, disposeSenseVoiceSession, isSenseVoiceReady } from '../sensevoice';

const WAV = process.env.SUBCAST_SV_SMOKE_WAV;
const SKIP = !WAV || !isSenseVoiceReady();

describe.skipIf(SKIP)('sensevoice engine smoke', () => {
  it('VAD-segments the wav and transcribes non-empty cues', async () => {
    const segments = await detectSpeechSegments(WAV!);
    expect(segments.length).toBeGreaterThan(0);

    const plans = planChunksFromVad(segments, { maxChunkSec: 10 });
    expect(plans.length).toBeGreaterThan(0);

    const t0 = Date.now();
    const cues = await transcribeSegmentsSenseVoice(WAV!, plans);
    const elapsedS = (Date.now() - t0) / 1000;

    console.log(
      `[smoke] vad segments=${segments.length} plans=${plans.length} cues=${cues.length} in ${elapsedS.toFixed(1)}s`,
    );
    for (const cue of cues.slice(0, 5)) {
        console.log(`  [${(cue.startMs / 1000).toFixed(1)}s–${(cue.endMs / 1000).toFixed(1)}s] ${cue.text}`);
    }

    expect(cues.length).toBeGreaterThan(0);
    // CJK sanity: at least one cue carries CJK text for a Chinese wav.
    expect(cues.some((c) => /[\u4e00-\u9fff]/.test(c.text))).toBe(true);
    // Timestamps are absolute and ordered.
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.startMs).toBeGreaterThanOrEqual(cues[i - 1]!.startMs);
    }
  });

  afterAll(async () => {
    await disposeSenseVoiceSession();
  });
});
