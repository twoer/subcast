/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llmQueue, translateQueue } from '../queue';
import { getDb, closeDb, SUBCAST_PATHS } from '../db';

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

  describe('attach self-heal on missing result file', () => {
    let cacheDir: string;

    beforeEach(() => {
      // Create original.vtt in SUBCAST_PATHS.cache so workers don't
      // immediately fail with ORIGINAL_NOT_READY before we can observe frames.
      cacheDir = join(SUBCAST_PATHS.cache, HASH_A);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'original.vtt'),
        'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
        'utf-8',
      );
    });

    afterEach(() => {
      rmSync(cacheDir, { recursive: true, force: true });
    });

    it('insight: done row + missing insights.json → demoted to queued', async () => {
      const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      getDb()
        .prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`)
        .run(Date.now(), t.id);
      // insights.json deliberately not written
      const frames: Array<{ event: string; data: { status?: string } }> = [];
      for await (const f of llmQueue.attach(t.id)) {
        frames.push(f as { event: string; data: { status?: string } });
        if (frames.length >= 5) break;
      }
      const queuedFrame = frames.find((f) => f.event === 'status' && f.data.status === 'queued');
      expect(queuedFrame).toBeDefined();
      const row = getDb()
        .prepare(`SELECT status FROM insight_tasks WHERE id=?`)
        .get(t.id) as { status: string };
      expect(row.status).not.toBe('done');
    });

    it('translate: completed row + missing {lang}.vtt → demoted to queued', async () => {
      const t = translateQueue.ensureTask(HASH_A, 'zh-CN');
      getDb()
        .prepare(`UPDATE translate_tasks SET status='completed', completed_at=? WHERE id=?`)
        .run(Date.now(), t.id);
      const frames: Array<{ event: string; data: { status?: string } }> = [];
      for await (const f of llmQueue.attach(t.id)) {
        frames.push(f as { event: string; data: { status?: string } });
        if (frames.length >= 5) break;
      }
      const queuedFrame = frames.find((f) => f.event === 'status' && f.data.status === 'queued');
      expect(queuedFrame).toBeDefined();
      const row = getDb()
        .prepare(`SELECT status FROM translate_tasks WHERE id=?`)
        .get(t.id) as { status: string };
      expect(row.status).not.toBe('completed');
    });
  });

  describe('cross-kind FIFO dequeue', () => {
    it('dequeues by created_at across translate and insight tables', async () => {
      const t1 = translateQueue.ensureTask(HASH_A, 'zh-CN');
      await new Promise((r) => setTimeout(r, 5));
      llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
      const next = getDb()
        .prepare(
          `SELECT id, kind FROM (
             SELECT id, 'translate' AS kind, created_at, priority AS sort_priority
             FROM translate_tasks WHERE status='queued'
             UNION ALL
             SELECT id, 'insight' AS kind, created_at, 0 AS sort_priority
             FROM insight_tasks WHERE status='queued'
           )
           ORDER BY sort_priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get() as { id: string; kind: string };
      expect(next.kind).toBe('translate');
      expect(next.id).toBe(t1.id);
    });
  });
});
