/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb } from '../db';
import {
  deleteInsightArtifact,
  insightArtifactPath,
  insightLatestPointerPath,
  readInsightArtifact,
  readLatestInsightArtifact,
  writeInsightArtifact,
} from '../artifactStore';

const HASH = 'a'.repeat(64);

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'subcast-artifact-store-'));
  process.env.SUBCAST_HOME = tmpHome;
});

afterEach(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.SUBCAST_HOME;
});

describe('artifactStore insight artifacts', () => {
  it('writes exact artifact files and a latest pointer', () => {
    const written = writeInsightArtifact(HASH, 'zh-CN', 'f'.repeat(64), {
      summary: 'ok',
    });

    expect(written).toMatchObject({
      kind: 'insight',
      videoSha: HASH,
      uiLanguage: 'zh-CN',
      fingerprint: 'f'.repeat(64),
      payload: { summary: 'ok' },
    });
    expect(insightArtifactPath(HASH, 'f'.repeat(64))).toContain(
      `/cache/${HASH}/artifacts/insight/${'f'.repeat(64)}.json`,
    );
    expect(readInsightArtifact(HASH, 'f'.repeat(64))?.payload).toEqual({ summary: 'ok' });
    expect(readLatestInsightArtifact(HASH, 'zh-CN', 'f'.repeat(64))?.payload).toEqual({
      summary: 'ok',
    });
  });

  it('does not trust latest pointers for a different fingerprint', () => {
    writeInsightArtifact(HASH, 'en', 'a'.repeat(64), { summary: 'old' });
    writeInsightArtifact(HASH, 'en', 'b'.repeat(64), { summary: 'new' });

    expect(readInsightArtifact(HASH, 'a'.repeat(64))?.payload).toEqual({ summary: 'old' });
    expect(readLatestInsightArtifact(HASH, 'en', 'a'.repeat(64))).toBeNull();
    expect(readLatestInsightArtifact(HASH, 'en', 'b'.repeat(64))?.payload).toEqual({
      summary: 'new',
    });
  });

  it('deletes the exact artifact and only removes matching latest pointer', () => {
    writeInsightArtifact(HASH, 'zh-CN', '1'.repeat(64), { summary: 'old' });
    writeInsightArtifact(HASH, 'zh-CN', '2'.repeat(64), { summary: 'new' });

    deleteInsightArtifact(HASH, 'zh-CN', '1'.repeat(64));

    expect(readInsightArtifact(HASH, '1'.repeat(64))).toBeNull();
    expect(readLatestInsightArtifact(HASH, 'zh-CN', '2'.repeat(64))).not.toBeNull();
    expect(insightLatestPointerPath(HASH, 'zh-CN')).toContain('latest-zh-CN.json');
  });
});
