/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Fire-and-forget `videos.duration_s` backfill.
 *
 * No import path populates duration on INSERT — the column used to be
 * written only by the transcribe worker's wav probe, so rows that were
 * imported before that logic existed (or never got transcribed) stay
 * NULL and starve the library/home duration display. This helper probes
 * the original media file directly with ffprobe and backfills the row.
 *
 * Probes run serially through one promise chain so a list sweep over a
 * library with many NULL rows doesn't fork a ffprobe per file at once.
 */
import { getDb } from './db';
import { probeDurationS } from './whisper';

const inFlight = new Set<string>();
/** Shas whose probe already failed once this process — don't retry every sweep. */
const dead = new Set<string>();
let queue: Promise<void> = Promise.resolve();

export function backfillVideoDurationS(sha256: string, videoPath: string): void {
  if (inFlight.has(sha256) || dead.has(sha256)) return;
  inFlight.add(sha256);
  queue = queue
    .then(() => probeDurationS(videoPath))
    .then((durationS) => {
      getDb()
        .prepare(
          `UPDATE videos SET duration_s = ? WHERE sha256 = ? AND duration_s IS NULL`,
        )
        .run(durationS, sha256);
    })
    .catch(() => {
      // Unreadable or undecodable media — leave NULL. Blacklist for this
      // process so repeated list sweeps don't re-probe a corrupt file.
      dead.add(sha256);
    })
    .finally(() => inFlight.delete(sha256));
}
