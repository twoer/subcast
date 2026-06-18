/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/diarize/[hash]/reconsolidate — Rerun Stage 2 only (~1-2 s).
 *
 * Body: { topK?: number, mergeThreshold?: number }
 *
 * Reads cached raw segments + per-raw-speaker centroids, runs the
 * consolidation algorithm with the new K, rewrites speaker_timeline,
 * leaves display_names untouched. Returns the new aggregates so the
 * frontend can update the smart-default view + warning ribbon
 * without a separate GET.
 */

import { defineEventHandler, getRouterParam, readBody, createError } from 'h3';
import { reconsolidate } from '../../../utils/diarize/diarize';
import { isValidHash } from '../../../utils/validate';

interface ReqBody {
  topK?: number;
  mergeThreshold?: number;
  majorSpeakerRatio?: number;
  minSpeakerSeconds?: number;
}

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash');
  if (!isValidHash(hash)) throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });

  const body = (await readBody<ReqBody>(event).catch(() => null)) ?? ({} as ReqBody);

  try {
    const result = reconsolidate(hash, {
      topK: body.topK,
      mergeThreshold: body.mergeThreshold,
      majorSpeakerRatio: body.majorSpeakerRatio,
      minSpeakerSeconds: body.minSpeakerSeconds,
    });
    return { ok: true as const, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw createError({
      statusCode: 409,
      statusMessage: 'RECONSOLIDATE_FAILED',
      data: { message },
    });
  }
});
