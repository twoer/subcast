/* SPDX-License-Identifier: Apache-2.0 */
// P6: transcribe → LLM pipelining — readiness gating, streaming workers,
// source-failure cancellation. Uses the translate.test.ts mock pattern
// (stubbed llmClient chat) plus a shrunken poll interval.
vi.hoisted(() => {
  process.env.SUBCAST_PIPELINE_POLL_MS = '10';
});

const chatMock = vi.hoisted(() => vi.fn());
vi.mock('../llmClient', () => ({
  llmBackend: () => ({
    chat: chatMock,
    // eslint-disable-next-line require-yield
    async *chatStream() { return; },
  }),
}));
vi.mock('../log', () => ({ logEvent: vi.fn() }));

/* eslint-disable import/first -- mocks must be registered before imports */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llmQueue, translateQueue } from '../queue';
import { pickNextLlmTask } from '../llmQueue';
import { pipelineReadyShas, readTranscriptSource } from '../transcriptSource';
import { getDb, closeDb, SUBCAST_PATHS } from '../db';
import { serializeVtt, type Cue } from '../vtt';

const HASH_A = 'a'.repeat(64);

let tmpHome: string;
let chatSeq = 0;

/** Compliant chat: echo back exactly N strings for whatever batch size. */
function mockCompliantChat() {
  chatMock.mockImplementation(async (opts: { messages: Array<{ content: string }> }) => {
    const last = opts.messages[opts.messages.length - 1]!.content;
    const m = last.match(/INPUT \((\d+)/);
    const n = m ? Number(m[1]) : 1;
    return {
      content: JSON.stringify(Array.from({ length: n }, () => `out ${chatSeq++}`)),
      finishReason: 'stop',
      usage: {},
      timing: { totalMs: 1 },
      retries: 0,
      coldStart: false,
    };
  });
}

function statusOf(table: string, id: string): string {
  return (
    getDb()
      .prepare(`SELECT status FROM ${table} WHERE id=?`)
      .get(id) as { status: string }
  ).status;
}

function createRunningTranscribe(totalChunks: number): string {
  const id = `tt-${Math.random().toString(36).slice(2)}`;
  getDb()
    .prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, total_chunks, done_chunks, created_at)
       VALUES (?, ?, 'running', 'sensevoice', ?, 0, ?)`,
    )
    .run(id, HASH_A, totalChunks, Date.now());
  return id;
}

/** Persist `chunks` chunk rows of `cuesPerChunk` cues each, starting at fromIdx. */
function addCueChunks(taskId: string, fromIdx: number, chunkCount: number, cuesPerChunk: number): void {
  const db = getDb();
  for (let c = 0; c < chunkCount; c++) {
    const chunkIdx = fromIdx + c;
    const cues: Cue[] = Array.from({ length: cuesPerChunk }, (_, i) => ({
      startMs: chunkIdx * 10_000 + i * 1_000,
      endMs: chunkIdx * 10_000 + i * 1_000 + 900,
      text: `原文 ${chunkIdx}-${i}`,
    }));
    db.prepare(
      `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json, quality, retry_count)
       VALUES (?, ?, ?, ?, ?, 'ok', 0)
       ON CONFLICT(task_id, chunk_idx) DO UPDATE SET cues_json = excluded.cues_json`,
    ).run(taskId, chunkIdx, chunkIdx * 10_000, chunkIdx * 10_000 + 9_999, JSON.stringify(cues));
  }
}

/** Mirror transcribeQueue's completion block: freeze the cue list. */
function completeTranscribe(taskId: string): void {
  const snap = readTranscriptSource(taskId);
  const cacheDir = join(SUBCAST_PATHS.cache, HASH_A);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'original.vtt'), serializeVtt(snap.cues), 'utf-8');
  const db = getDb();
  db.prepare(
    `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
     VALUES (?, 'original', 'transcribed', ?, ?)
     ON CONFLICT(video_sha, lang) DO UPDATE SET completed_at = excluded.completed_at`,
  ).run(HASH_A, snap.cues.length, Date.now());
  db.prepare(`UPDATE transcribe_tasks SET status='completed', completed_at=? WHERE id=?`)
    .run(Date.now(), taskId);
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'llmpipe-'));
  process.env.SUBCAST_HOME = tmpHome;
  closeDb();
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, 'a.mp4', '.mp4', 1, ?, ?)`,
  ).run(HASH_A, Date.now(), Date.now());
  chatSeq = 0;
  chatMock.mockReset();
  mockCompliantChat();
  // Reset singleton queue state leaked by previous tests (slots/pause).
  (llmQueue as unknown as { activeSlots: unknown[] }).activeSlots = [];
});

afterEach(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.SUBCAST_HOME;
});

describe('transcriptSource readiness', () => {
  it('marks a sha ready only after a full super-batch of live cues', () => {
    const tid = createRunningTranscribe(10);
    expect(pipelineReadyShas().has(HASH_A)).toBe(false);
    addCueChunks(tid, 0, 4, 5); // 20 cues — one short
    expect(pipelineReadyShas().has(HASH_A)).toBe(false);
    addCueChunks(tid, 4, 1, 5); // 25
    expect(pipelineReadyShas().has(HASH_A)).toBe(true);
  });

  it('treats a finished transcription (subtitles row) as ready', () => {
    getDb()
      .prepare(
        `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
         VALUES (?, 'original', 'transcribed', 3, ?)`,
      )
      .run(HASH_A, Date.now());
    expect(pipelineReadyShas().has(HASH_A)).toBe(true);
  });

  it('pickNextLlmTask gates translate/polish on readyShas but exempts insight', async () => {
    const t = translateQueue.ensureTask(HASH_A, 'zh-CN');
    await settle(5);
    const insight = llmQueue.ensureInsightTask(HASH_A, 'en', '8b');
    // Nothing ready → only the insight row is dispatchable.
    expect(pickNextLlmTask(false, new Set<string>())?.id).toBe(insight.id);
    // Ready → FIFO returns the older translate.
    expect(pickNextLlmTask(false, new Set([HASH_A]))?.id).toBe(t.id);
  });
});

describe('pipelined polish worker', () => {
  it('stays queued below a super-batch, dispatches at 25 cues, and cancels with its source', async () => {
    const tid = createRunningTranscribe(10);
    addCueChunks(tid, 0, 3, 5); // 15 cues
    const task = llmQueue.ensurePolishTask(HASH_A);
    await llmQueue.tryStartNext();
    expect(statusOf('polish_tasks', task.id)).toBe('queued');

    addCueChunks(tid, 3, 2, 5); // 25 cues — ready
    await llmQueue.tryStartNext();
    expect(statusOf('polish_tasks', task.id)).toBe('running');
    await settle(); // batch 1 completes against the mocked chat
    expect(chatMock).toHaveBeenCalledTimes(1);

    // Source canceled → linked cancellation of the pipelined task.
    llmQueue.cancelTasksForSource(HASH_A, 'test');
    await settle(50);
    expect(statusOf('polish_tasks', task.id)).toBe('canceled');
    // No partial layer was persisted.
    expect(existsSync(join(SUBCAST_PATHS.cache, HASH_A, 'polished.vtt'))).toBe(false);
  });

  it('streams batches as cues land and finalizes on source completion', async () => {
    const tid = createRunningTranscribe(6);
    addCueChunks(tid, 0, 5, 5); // 25 cues
    const task = llmQueue.ensurePolishTask(HASH_A);
    await llmQueue.tryStartNext();
    expect(statusOf('polish_tasks', task.id)).toBe('running');
    await settle();
    expect(chatMock).toHaveBeenCalledTimes(1); // exactly one full batch fired

    // Trailing 5 cues + completion: the final partial batch may only run
    // once original.vtt freezes the cue list.
    addCueChunks(tid, 5, 1, 5);
    await settle();
    expect(chatMock).toHaveBeenCalledTimes(1); // still held back while live

    completeTranscribe(tid);
    await settle(60);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(statusOf('polish_tasks', task.id)).toBe('completed');
    expect(existsSync(join(SUBCAST_PATHS.cache, HASH_A, 'polished.vtt'))).toBe(true);
    const subs = getDb()
      .prepare(`SELECT cues_count FROM subtitles WHERE video_sha=? AND lang='polished'`)
      .get(HASH_A) as { cues_count: number };
    expect(subs.cues_count).toBe(30);
  });

  it('frame stream ends with done after attach', async () => {
    const tid = createRunningTranscribe(5);
    addCueChunks(tid, 0, 5, 5);
    const task = llmQueue.ensurePolishTask(HASH_A);
    await llmQueue.tryStartNext();
    const frames: Array<{ event: string }> = [];
    const drive = (async () => {
      for await (const f of llmQueue.attach(task.id)) {
        frames.push(f as { event: string });
      }
    })();
    await settle();
    completeTranscribe(tid);
    await drive;
    const events = frames.map((f) => f.event);
    expect(events).toContain('cue-polished');
    expect(events).toContain('batch-progress');
    expect(events[events.length - 1]).toBe('done');
  });
});

describe('pipelined translate worker', () => {
  it('translates off a live source and finalizes', async () => {
    const tid = createRunningTranscribe(5);
    addCueChunks(tid, 0, 5, 5);
    const task = translateQueue.ensureTask(HASH_A, 'ja');
    await llmQueue.tryStartNext();
    expect(statusOf('translate_tasks', task.id)).toBe('running');
    completeTranscribe(tid);
    await settle(60);
    expect(statusOf('translate_tasks', task.id)).toBe('completed');
    expect(existsSync(join(SUBCAST_PATHS.cache, HASH_A, 'ja.vtt'))).toBe(true);
    const subs = getDb()
      .prepare(`SELECT cues_count FROM subtitles WHERE video_sha=? AND lang='ja'`)
      .get(HASH_A) as { cues_count: number };
    expect(subs.cues_count).toBe(25);
  });
});

describe('boot zombie recovery for polish (02.recover-zombie-tasks)', () => {
  const runPlugin = async () => {
    vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn);
    try {
      const mod = await import('../../plugins/02.recover-zombie-tasks');
      await (mod.default as () => Promise<void>)();
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('web mode re-queues a zombie running polish row', async () => {
    const task = llmQueue.ensurePolishTask(HASH_A);
    getDb().prepare(`UPDATE polish_tasks SET status='running' WHERE id=?`).run(task.id);
    delete process.env.SUBCAST_DESKTOP;
    await runPlugin();
    expect(statusOf('polish_tasks', task.id)).toBe('queued');
  });

  it('desktop mode fails it with an explanatory message', async () => {
    const task = llmQueue.ensurePolishTask(HASH_A);
    getDb().prepare(`UPDATE polish_tasks SET status='running' WHERE id=?`).run(task.id);
    process.env.SUBCAST_DESKTOP = 'true';
    try {
      await runPlugin();
    } finally {
      delete process.env.SUBCAST_DESKTOP;
    }
    const row = getDb()
      .prepare(`SELECT status, error_msg FROM polish_tasks WHERE id=?`)
      .get(task.id) as { status: string; error_msg: string };
    expect(row.status).toBe('failed');
    expect(row.error_msg).toContain('Interrupted');
  });
});
