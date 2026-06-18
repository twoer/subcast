/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: m } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: t } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path');
  const r = m(j(t(), 'subcast-wf-api-'));
  process.env.SUBCAST_HOME = r;
  return { tmpRoot: r };
});

/* eslint-disable import/first -- vi.hoisted must precede imports */
import handler from '../../api/waveform.get';
import { getDb, SUBCAST_PATHS } from '../db';
import { FFMPEG_PATH } from '../ffmpegPaths';
/* eslint-enable import/first */

const HASH = 'a'.repeat(64);

async function callHandler(query: Record<string, string>): Promise<{ status: number; body: unknown }> {
  let status = 200;
  const url = `/api/waveform?${new URLSearchParams(query).toString()}`;
  const event = {
    path: url,
    node: {
      req: { url, method: 'GET', headers: {}, on: () => {} },
      res: { setHeader: () => {}, getHeader: () => undefined, end: () => {} },
    },
    context: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  try {
    const body = await handler(event);
    return { status, body };
  } catch (err) {
    status = (err as { statusCode?: number }).statusCode ?? 500;
    return { status, body: err };
  }
}

beforeAll(() => {
  mkdirSync(SUBCAST_PATHS.videos, { recursive: true });
  const wavPath = join(SUBCAST_PATHS.videos, `${HASH}.wav`);
  execFileSync(FFMPEG_PATH, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5:sample_rate=8000',
    '-ac', '1', '-ar', '8000', wavPath,
  ], { stdio: 'ignore' });
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'tone.wav', '.wav', 1234, Date.now(), Date.now());
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /api/waveform', () => {
  it('rejects bad hash', async () => {
    const res = await callHandler({ hash: 'not-a-hash' });
    expect(res.status).toBe(400);
  });

  it('404s for unknown but well-formed hash', async () => {
    const res = await callHandler({ hash: 'b'.repeat(64) });
    expect(res.status).toBe(404);
  });

  it('returns 500 peaks on first call (cache miss → generate)', async () => {
    const res = await callHandler({ hash: HASH });
    expect(res.status).toBe(200);
    const body = res.body as { version: number; peaks: number[] };
    expect(body.version).toBe(1);
    expect(body.peaks).toHaveLength(500);
    expect(existsSync(join(SUBCAST_PATHS.cache, HASH, 'waveform.json'))).toBe(true);
  });

  it('returns identical peaks on second call (cache hit)', async () => {
    const a = (await callHandler({ hash: HASH })).body as { peaks: number[] };
    const b = (await callHandler({ hash: HASH })).body as { peaks: number[] };
    expect(b.peaks).toEqual(a.peaks);
  });

  it('sets videos.has_waveform = 1 after cache-miss generation', async () => {
    // Clear cache + flag to force the cache-miss path.
    const cachePath = join(SUBCAST_PATHS.cache, HASH, 'waveform.json');
    if (existsSync(cachePath)) rmSync(cachePath);
    getDb().prepare('UPDATE videos SET has_waveform = 0 WHERE sha256 = ?').run(HASH);

    await callHandler({ hash: HASH });

    const row = getDb()
      .prepare('SELECT has_waveform FROM videos WHERE sha256 = ?')
      .get(HASH) as { has_waveform: number };
    expect(row.has_waveform).toBe(1);
  });
});
