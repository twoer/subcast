/* SPDX-License-Identifier: Apache-2.0 */

/**
 * End-to-end smoke test for the diarize pipeline (Stage 1 + Stage 2).
 *
 * Disabled by default — sherpa loads native binding + the test wav
 * lives outside the repo. To run:
 *
 *   SUBCAST_DIARIZE_SMOKE_WAV=/path/to/16khz-mono.wav pnpm vitest run \
 *     server/utils/diarize/__tests__/pipeline-smoke.test.ts
 *
 * Expected for user's 25-min wav at Top-K=2:
 *   speaker_A ~ 55-57%
 *   speaker_B ~ 40-43%
 *   unknown   ~ 1-4%
 */

import { describe, it, expect } from 'vitest';
import { runRawDiarization } from '../rawDiarization';
import { consolidate } from '../consolidate';

const WAV = process.env.SUBCAST_DIARIZE_SMOKE_WAV;

// Vitest `it.skipIf` lets us conditionally skip without polluting the
// "passed" count with a fake pass.
const SKIP = !WAV;

describe.skipIf(SKIP)('diarize pipeline smoke', () => {
  it('runs Stage 1 + Stage 2 end-to-end and reports plausible output', async () => {
    const raw = await runRawDiarization(WAV!);

    // Stage 1 sanity.
    expect(raw.rawSegments.length).toBeGreaterThan(0);
    expect(raw.rawSpeakers.length).toBeGreaterThan(0);
    expect(raw.sampleRate).toBe(16000);

    console.log(
      `[smoke stage1] raw segments=${raw.rawSegments.length}, raw speakers=${raw.rawSpeakers.length}, ` +
        `sherpa=${(raw.processMs / 1000).toFixed(1)}s, embeddings=${(raw.embeddingMs / 1000).toFixed(1)}s`,
    );

    // Stage 2.
    const result = consolidate(raw.rawSegments, raw.rawSpeakers, { topK: 2 });

    expect(result.finalSpeakerCount).toBe(2);
    expect(result.speakers).toHaveLength(2);
    expect(result.speakers[0]!.speakerId).toBe('speaker_A');
    expect(result.speakers[1]!.speakerId).toBe('speaker_B');
    // Speaker A is by definition the longest-speaking.
    expect(result.speakers[0]!.durationS).toBeGreaterThan(result.speakers[1]!.durationS);

    // Loose unknown ratio bound — the algorithm should not be losing
    // more than ~30% of speech to unknown on a reasonable input.
    expect(result.unknownRatio).toBeLessThan(0.3);

    console.log(
      `[smoke stage2] raw=${result.rawSpeakerCount} → final=${result.finalSpeakerCount}, ` +
        `A=${(result.speakers[0]!.ratio * 100).toFixed(1)}%, ` +
        `B=${(result.speakers[1]!.ratio * 100).toFixed(1)}%, ` +
        `unknown=${(result.unknownRatio * 100).toFixed(1)}%`,
    );
  }, /* 8 min timeout for long videos */ 8 * 60 * 1000);
});
