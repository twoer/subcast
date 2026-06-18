/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-batch-stage-'));
});

vi.mock('../waveform', () => ({
  generateWaveform: vi.fn(async () => [0, 0, 0]),
}));

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { commitBatchStage, stageBatchVideo } from '../batchStage';
import { getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const BYTES = new Uint8Array([1, 2, 3, 4]);
const HASH = createHash('sha256').update(BYTES).digest('hex');

function makeFile(): File {
  return new File([BYTES], 'clip.mp4', { type: 'video/mp4' });
}

beforeEach(async () => {
  const db = getDb();
  db.exec('DELETE FROM videos');
  await rm(SUBCAST_PATHS.videos, { recursive: true, force: true });
  await rm(SUBCAST_PATHS.tmp, { recursive: true, force: true });
});

describe('batch stage imports', () => {
  it('stages without creating a library row, then commits into videos', async () => {
    const staged = await stageBatchVideo(makeFile());

    expect(staged).toMatchObject({ hash: HASH, existed: false });
    expect(staged.stageId).toBeTruthy();
    expect(getDb().prepare('SELECT sha256 FROM videos WHERE sha256 = ?').get(HASH)).toBeUndefined();

    await commitBatchStage(staged.stageId!);

    expect(getDb().prepare('SELECT sha256 FROM videos WHERE sha256 = ?').get(HASH)).toEqual({
      sha256: HASH,
    });
    expect(existsSync(join(SUBCAST_PATHS.videos, `${HASH}.mp4`))).toBe(true);
  });

  it('returns an existing hash without leaving a staged file', async () => {
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
         VALUES (?, 'clip.mp4', '.mp4', 4, ?, ?)`,
      )
      .run(HASH, now, now);

    const staged = await stageBatchVideo(makeFile());

    expect(staged).toMatchObject({ hash: HASH, existed: true, stageId: null });
  });
});
