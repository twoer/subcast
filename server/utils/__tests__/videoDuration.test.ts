/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const probeMock = vi.hoisted(() => vi.fn(async (_path: string) => 42.5));
vi.mock('../whisper', () => ({ probeDurationS: probeMock }));

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-video-duration-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { getDb } from '../db';
import { backfillVideoDurationS } from '../videoDuration';
/* eslint-enable import/first */

function insertVideo(sha: string, durationS: number | null): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, duration_s, created_at, last_opened_at)
       VALUES (?, 'clip.mp4', '.mp4', 1024, ?, ?, ?)`,
    )
    .run(sha, durationS, now, now);
}

function readDuration(sha: string): number | null {
  const row = getDb()
    .prepare('SELECT duration_s FROM videos WHERE sha256 = ?')
    .get(sha) as { duration_s: number | null };
  return row.duration_s;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  probeMock.mockReset();
  probeMock.mockImplementation(async () => 42.5);
});

describe('backfillVideoDurationS', () => {
  it('probes the media file and fills a NULL duration', async () => {
    const sha = 'a'.repeat(64);
    insertVideo(sha, null);
    backfillVideoDurationS(sha, '/videos/a.mp4');
    await vi.waitFor(() => expect(readDuration(sha)).toBe(42.5));
    expect(probeMock).toHaveBeenCalledWith('/videos/a.mp4');
  });

  it('never overwrites an existing duration (IS NULL guard)', async () => {
    const sha = 'b'.repeat(64);
    insertVideo(sha, 99);
    backfillVideoDurationS(sha, '/videos/b.mp4');
    await vi.waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(readDuration(sha)).toBe(99);
  });

  it('blacklists a sha whose probe failed instead of retrying every sweep', async () => {
    const sha = 'c'.repeat(64);
    insertVideo(sha, null);
    probeMock.mockImplementation(async () => {
      throw new Error('ffprobe failed');
    });
    backfillVideoDurationS(sha, '/videos/c.mp4');
    await vi.waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
    await settle();
    backfillVideoDurationS(sha, '/videos/c.mp4');
    await settle();
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(readDuration(sha)).toBeNull();
  });
});
