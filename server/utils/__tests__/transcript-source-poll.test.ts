/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db';
import { pollTranscriptSource, readTranscriptSource } from '../transcriptSource';

const cue = (startMs: number, text: string) => ({ startMs, endMs: startMs + 900, text });

describe('pollTranscriptSource (incremental cursor)', () => {
  let home: string;

  const insertChunk = (idx: number, cues: unknown): void => {
    getDb()
      .prepare(
        `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json, quality)
         VALUES ('t1', ?, ?, ?, ?, 'ok')`,
      )
      .run(idx, idx * 1000, idx * 1000 + 1000, JSON.stringify(cues));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'subcast-srcpoll-'));
    process.env.SUBCAST_HOME = home;
    const db = getDb();
    db.prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES ('sha1', 'a.mp4', '.mp4', 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
       VALUES ('t1', 'sha1', 'running', 'whisper', 0)`,
    ).run();
    insertChunk(0, [cue(0, 'a'), cue(1000, 'b')]);
    insertChunk(1, [cue(2000, 'c')]);
  });

  afterEach(() => {
    closeDb();
    rmSync(home, { recursive: true, force: true });
    delete process.env.SUBCAST_HOME;
  });

  it('first poll from a fresh cursor equals readTranscriptSource', () => {
    const fresh = readTranscriptSource('t1');
    const state = { lastChunkIdx: -1, doneChunks: 0, cues: [] as ReturnType<typeof readTranscriptSource>['cues'] };
    const snap = pollTranscriptSource('t1', state);
    expect(snap.cues).toEqual(fresh.cues);
    expect(snap.doneChunks).toBe(2);
    expect(snap.totalChunks).toBe(fresh.totalChunks);
    expect(snap.live).toBe(true);
    expect(state.lastChunkIdx).toBe(1);
  });

  it('subsequent polls append only new chunk rows', () => {
    const state = { lastChunkIdx: -1, doneChunks: 0, cues: [] as ReturnType<typeof readTranscriptSource>['cues'] };
    pollTranscriptSource('t1', state);
    const cuesRef = state.cues;

    insertChunk(2, [cue(3000, 'd'), cue(4000, 'e')]);
    const snap = pollTranscriptSource('t1', state);
    expect(snap.doneChunks).toBe(3);
    expect(snap.cues.map((c) => c.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // accumulated in place — no copy churn
    expect(snap.cues).toBe(cuesRef);
    expect(state.lastChunkIdx).toBe(2);

    // no new rows → snapshot unchanged, no growth
    const again = pollTranscriptSource('t1', state);
    expect(again.cues.length).toBe(5);
    expect(again.doneChunks).toBe(3);
  });

  it('live flips false once the task reaches a terminal state', () => {
    getDb().prepare(`UPDATE transcribe_tasks SET status = 'completed' WHERE id = 't1'`).run();
    const state = { lastChunkIdx: -1, doneChunks: 0, cues: [] as ReturnType<typeof readTranscriptSource>['cues'] };
    const snap = pollTranscriptSource('t1', state);
    expect(snap.live).toBe(false);
    expect(snap.cues.length).toBe(3);
  });
});
