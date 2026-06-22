/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseProgressLine,
  humanSizeToBytes,
  parseEta,
  guessExtFromUrl,
  buildOriginalName,
  urlImportQueue,
} from '../urlImportQueue';

describe('parseProgressLine', () => {
  it('parses a typical mid-download PROGRESS line', () => {
    const line = 'PROGRESS  53.6% of    7.46MiB at    3.85MiB/s ETA 00:00';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.phase).toBe('downloading');
    expect(frame!.percent).toBeCloseTo(0.536, 3);
    expect(frame!.bytesTotal).toBe(7_822_377); // 7.46 MiB
    expect(frame!.bytesDone).toBeCloseTo(4_192_794, -3); // ~53.6% of total
    expect(frame!.speed).toBe('3.85MiB/s');
    expect(frame!.eta).toBe(0);
  });

  it('parses the opening 0.0% line (before size is known)', () => {
    const line = 'PROGRESS   0.0% of    7.46MiB at   34.72KiB/s ETA 03:40';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.percent).toBe(0);
    expect(frame!.bytesTotal).toBe(7_822_377);
    expect(frame!.eta).toBe(220); // 03:40 = 220s
  });

  it('parses the 100% completion line', () => {
    const line = 'PROGRESS 100.0% of    7.46MiB at    6.29MiB/s ETA 00:00';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.percent).toBe(1);
    expect(frame!.bytesDone).toBe(frame!.bytesTotal);
  });

  it('handles ETA: NA (unknown remaining time)', () => {
    const line = 'PROGRESS 100.0% of    7.46MiB at 2.60MiB/s ETA NA';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.eta).toBeUndefined();
  });

  it('returns null for non-progress yt-dlp log lines', () => {
    expect(parseProgressLine('[generic] Extracting URL: https://example.com')).toBeNull();
    expect(parseProgressLine('[download] Destination: /tmp/foo.mp4')).toBeNull();
    expect(parseProgressLine('WARNING: [generic] Falling back')).toBeNull();
    expect(parseProgressLine('[info] cO1bqBnu5qs: Downloading 1 format(s): 0')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
  });

  it('parses the opening ticks where speed/eta are "Unknown"', () => {
    // yt-dlp emits these before the first bytes arrive. Percent + total
    // are real; speed/eta are placeholders and must come back undefined.
    const line = 'PROGRESS   0.0% of    7.46MiB at  Unknown B/s ETA Unknown';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.percent).toBe(0);
    expect(frame!.bytesTotal).toBe(7_822_377);
    expect(frame!.speed).toBeUndefined();
    expect(frame!.eta).toBeUndefined();
  });

  it('parses speed/eta when yt-dlp reports real values', () => {
    const line = 'PROGRESS   6.7% of    7.46MiB at  580.21KiB/s ETA 00:12';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.speed).toBe('580.21KiB/s');
    expect(frame!.eta).toBe(12);
  });

  it('clamps an out-of-range percentage (defensive)', () => {
    // yt-dlp shouldn't emit >100%, but the parser must not blow up.
    const line = 'PROGRESS 105.0% of    7.46MiB at    6.29MiB/s ETA 00:00';
    const frame = parseProgressLine(line);
    expect(frame).not.toBeNull();
    expect(frame!.percent).toBe(1); // clamped
  });
});

describe('humanSizeToBytes', () => {
  it('converts binary-prefixed sizes', () => {
    expect(humanSizeToBytes('7.46MiB')).toBe(7_822_377);
    expect(humanSizeToBytes('1KiB')).toBe(1024);
    expect(humanSizeToBytes('1GiB')).toBe(1_073_741_824);
    expect(humanSizeToBytes('512B')).toBe(512);
  });

  it('returns undefined for unparseable input', () => {
    expect(humanSizeToBytes('unknown')).toBeUndefined();
    expect(humanSizeToBytes('NA')).toBeUndefined();
    expect(humanSizeToBytes('')).toBeUndefined();
  });
});

describe('parseEta', () => {
  it('parses mm:ss and h:mm:ss formats', () => {
    expect(parseEta('00:08')).toBe(8);
    expect(parseEta('03:40')).toBe(220);
    expect(parseEta('01:00:00')).toBe(3600);
  });

  it('returns undefined for NA', () => {
    expect(parseEta('NA')).toBeUndefined();
  });

  it('falls back to bare-seconds parsing', () => {
    expect(parseEta('42')).toBe(42);
  });
});

describe('guessExtFromUrl', () => {
  it('extracts a known media extension from the path', () => {
    expect(guessExtFromUrl('https://example.com/video.mp4')).toBe('.mp4');
    expect(guessExtFromUrl('https://example.com/path/to/audio.MP3')).toBe('.mp3');
    expect(guessExtFromUrl('https://example.com/x.mkv?token=abc')).toBe('.mkv');
  });

  it('defaults to .mp4 when no extension is present (web video pages)', () => {
    expect(guessExtFromUrl('https://go.screenpal.com/watch/cO1bqBnu5qs')).toBe('.mp4');
    expect(guessExtFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('.mp4');
  });

  it('defaults to .mp4 for an invalid URL', () => {
    expect(guessExtFromUrl('not a url')).toBe('.mp4');
  });
});

describe('buildOriginalName', () => {
  it('appends the resolved extension to the URL slug', () => {
    expect(buildOriginalName('https://example.com/episode', '.mp4')).toBe('episode.mp4');
    expect(buildOriginalName('https://example.com/path/to/clip', '.webm')).toBe('clip.webm');
  });

  it('strips a trailing media extension to avoid double-suffixes', () => {
    // The original code produced `video.mp3.mp3` here; the strip prevents it.
    expect(buildOriginalName('https://example.com/video.mp3', '.mp3')).toBe('video.mp3');
    expect(buildOriginalName('https://example.com/x/lecture.MP4', '.mp4')).toBe('lecture.mp4');
    expect(buildOriginalName('https://example.com/audio.m4a?token=abc', '.m4a')).toBe('audio.m4a');
  });

  it('replaces a mismatched extension with the real one (post-transcode)', () => {
    // URL said .mp4 but yt-dlp actually delivered .m4a (audio-only stream).
    // The DB row should reflect the real container, not the URL hint.
    expect(buildOriginalName('https://example.com/podcast.mp4', '.m4a')).toBe('podcast.m4a');
  });

  it('ignores the query string and uses only the path segment', () => {
    // new URL(...).pathname excludes ?query, so a watch URL with a query
    // param uses the bare path segment as the slug.
    expect(buildOriginalName('https://example.com/watch?v=abc', '.mp4')).toBe('watch.mp4');
  });

  it('falls back to a generic name for an unparseable URL', () => {
    expect(buildOriginalName('not a url', '.mp4')).toBe('url-import.mp4');
  });

  it('uses "video" when the path has no trailing segment', () => {
    expect(buildOriginalName('https://example.com/', '.mp4')).toBe('video.mp4');
  });
});

// ---------------------------------------------------------------------------
// URL dedup — needs a real DB (with the user_version 13 source_url column).
// Kept in this file because it exercises urlImportQueue.ensureTask, which
// lives next to the pure parsers above.
// ---------------------------------------------------------------------------

// Set SUBCAST_HOME before importing the DB / queue so migrations run against
// a throwaway dir. hoisted runs before any import resolves.
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const home = mkdtempSync(join(tmpdir(), 'subcast-urlimport-dedup-'));
  process.env.SUBCAST_HOME = home;
  // Create the videos dir + a placeholder media file so lookupExistingImport's
  // on-disk existence check passes.
  mkdirSync(join(home, 'videos'), { recursive: true });
  mkdirSync(join(home, 'cache'), { recursive: true });
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { getDb, SUBCAST_PATHS } from '../db';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
/* eslint-enable import/first */

const DEDUP_URL = 'https://go.screenpal.com/watch/dedup-test';
const DEDUP_SHA = 'a'.repeat(64);

function seedDedupVideo(): void {
  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at, source_url)
     VALUES (?, 'dedup.mp4', '.mp4', 1024, ?, ?, ?)`,
  ).run(DEDUP_SHA, now, now, DEDUP_URL);
  // lookupExistingImport verifies the media file exists on disk.
  writeFileSync(join(SUBCAST_PATHS.videos, `${DEDUP_SHA}.mp4`), 'fake mp4');
}

describe('urlImportQueue.ensureTask — source_url dedup', () => {
  it('short-circuits to a done task when the URL was imported before', () => {
    seedDedupVideo();
    const task = urlImportQueue.ensureTask(DEDUP_URL);
    expect(task.phase).toBe('done');
    expect(task.lastFrame?.phase).toBe('done');
    expect(task.lastFrame?.hash).toBe(DEDUP_SHA);
  });

  it('does not short-circuit for a URL never imported before', () => {
    const task = urlImportQueue.ensureTask('https://example.com/never-imported');
    // New URL → goes to queued (will attempt download). We only assert the
    // phase here; the actual yt-dlp spawn is out of scope for this unit test.
    expect(task.phase).toBe('queued');
  });
});
