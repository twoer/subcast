/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llmQueue } from '../queue';
import { getDb, closeDb } from '../db';

const HASH_A = 'a'.repeat(64);

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'llmq-'));
  process.env.SUBCAST_HOME = tmpHome;
  // Force fresh db for this test home
  closeDb();
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'a.mp4', '.mp4', 1, ?, ?)`,
  ).run(HASH_A, Date.now(), Date.now());
});

afterEach(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.SUBCAST_HOME;
});

describe('LLMQueue', () => {
  describe('ensureInsightTask', () => {
    it('creates a new queued row when none exists', () => {
      const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      expect(t.status).toBe('queued');
      expect(t.video_sha).toBe(HASH_A);
      expect(t.ui_language).toBe('zh-CN');
    });

    it('returns existing row instead of creating duplicate', () => {
      const a = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      const b = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      expect(b.id).toBe(a.id);
    });

    it('keeps separate rows for different ui_language', () => {
      const a = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      const b = llmQueue.ensureInsightTask(HASH_A, 'en', 'qwen2.5:7b');
      expect(b.id).not.toBe(a.id);
    });

    it('resurrects error row back to queued', () => {
      const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      getDb()
        .prepare(`UPDATE insight_tasks SET status='error', error_msg='boom' WHERE id=?`)
        .run(t.id);
      const r = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      expect(r.id).toBe(t.id);
      expect(r.status).toBe('queued');
      expect(r.error_msg).toBeNull();
    });

    it('resurrects canceled row back to queued', () => {
      const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      getDb()
        .prepare(`UPDATE insight_tasks SET status='canceled' WHERE id=?`)
        .run(t.id);
      const r = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      expect(r.status).toBe('queued');
    });

    it('returns running row as-is without resurrection', () => {
      const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      getDb()
        .prepare(`UPDATE insight_tasks SET status='running' WHERE id=?`)
        .run(t.id);
      const r = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      expect(r.id).toBe(t.id);
      expect(r.status).toBe('running');
    });

    it('returns done row as-is without resurrection', () => {
      const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      getDb()
        .prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`)
        .run(Date.now(), t.id);
      const r = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      expect(r.id).toBe(t.id);
      expect(r.status).toBe('done');
    });
  });
});
