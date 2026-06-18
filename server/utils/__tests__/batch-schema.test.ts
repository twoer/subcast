/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  process.env.SUBCAST_HOME = mkdtempSync(join(tmpdir(), 'subcast-batch-schema-'));
});

/* eslint-disable import/first -- SUBCAST_HOME must be set before db import */
import { getDb } from '../db';
/* eslint-enable import/first */

describe('batch schema', () => {
  it('creates batch job and item tables', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('batch_jobs', 'batch_items')")
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name).sort()).toEqual(['batch_items', 'batch_jobs']);
  });

  it('enforces batch item foreign keys', () => {
    const db = getDb();
    expect(() => {
      db.prepare(
        `INSERT INTO batch_items
          (id, batch_id, video_sha, status, step_status_json, created_at)
         VALUES ('item-missing', 'batch-missing', ?, 'queued', '{}', ?)`,
      ).run('a'.repeat(64), Date.now());
    }).toThrow(/FOREIGN KEY/);
  });
});
