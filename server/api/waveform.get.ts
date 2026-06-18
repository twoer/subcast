/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineEventHandler, getQuery, createError } from 'h3';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { generateWaveform } from '../utils/waveform';
import { HASH_RE } from '../utils/validate';
import type { VideoRow } from '../types/db';

interface WaveformPayload {
  version: 1;
  peaks: number[];
}

/**
 * In-process dedup: when two players request the same hash concurrently,
 * share the single ffmpeg run. The map entry is cleared once the
 * promise settles, so cache-hit-after-miss requests fall through to the
 * fast on-disk path.
 */
const inflight = new Map<string, Promise<WaveformPayload>>();

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!HASH_RE.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const cachePath = join(SUBCAST_PATHS.cache, hash, 'waveform.json');
  if (existsSync(cachePath)) {
    try {
      return JSON.parse(readFileSync(cachePath, 'utf-8')) as WaveformPayload;
    } catch {
      // Corrupted cache — fall through to regenerate.
    }
  }

  const existing = inflight.get(hash);
  if (existing) return existing;

  const row = getDb()
    .prepare('SELECT sha256, ext FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'sha256' | 'ext'> | undefined;
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  const videoPath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);

  const work = (async (): Promise<WaveformPayload> => {
    const peaks = await generateWaveform(videoPath);
    const payload: WaveformPayload = { version: 1, peaks };
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(payload));
    // Mark the row so the future media-analysis scanner can skip
    // already-done videos without statting the cache directory.
    getDb().prepare('UPDATE videos SET has_waveform = 1 WHERE sha256 = ?').run(hash);
    return payload;
  })();

  inflight.set(hash, work);
  try {
    return await work;
  } finally {
    inflight.delete(hash);
  }
});
