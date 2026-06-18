# Local Knowledge QA Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Subcast v0.4.0's local knowledge base: index completed transcripts, search across local media, and ask cross-file questions with clickable source citations.

**Architecture:** Add a SQLite-backed knowledge layer beside the existing media/cache graph. v0.4.0 uses SQLite FTS5 plus Chinese n-gram search text and the existing `llmQueue`; no embeddings, no cloud calls, no separate worker pool. The UI adds an independent `/knowledge` workbench, while player links support `?t=<ms>` deep seeks.

**Tech Stack:** Nuxt 4, Vue 3, Nitro server routes, better-sqlite3, SQLite FTS5, Chinese 2-gram / 3-gram indexing, existing `llmQueue`, Vitest.

---

## Pre-Flight

The current working tree already contains unrelated batch-processing changes. Before implementing this plan, isolate the work:

```bash
git status --short
git switch -c codex/local-knowledge-qa
```

If the batch work is not ready to commit, use a separate worktree or finish/stash it first. This feature will touch `server/utils/db.ts`, `server/utils/mediaGraphDelete.ts`, i18n files, app navigation, and tests, so mixing two large changes will be painful.

Recommended first slice:

1. DB schema + types.
2. Indexer + search API.
3. Player deep-link.
4. Ask prompt + API.
5. Knowledge UI.
6. Privacy and deletion integration.

Do not implement tags, embeddings, or saved collections in v0.4.0. Scope selection supports all files, current search results, and manually selected files.

---

## Task 1: Add Knowledge Schema And Types

**Files:**
- Modify: `server/utils/db.ts`
- Modify: `server/types/db.ts`
- Create: `shared/knowledge.ts`
- Test: `server/utils/__tests__/knowledge-schema.test.ts`

**Step 1: Write the failing schema test**

Create `server/utils/__tests__/knowledge-schema.test.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'subcast-knowledge-schema-'));
  process.env.SUBCAST_HOME = home;
});

afterEach(async () => {
  const { closeDb } = await import('../db');
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUBCAST_HOME;
  vi.resetModules();
});

describe('knowledge schema', () => {
  it('creates knowledge tables and FTS index', async () => {
    const { getDb } = await import('../db');
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE name IN ('knowledge_chunks', 'knowledge_chunks_fts', 'qa_history')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((r) => r.name)).toEqual([
      'knowledge_chunks',
      'knowledge_chunks_fts',
      'qa_history',
    ]);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm test:run server/utils/__tests__/knowledge-schema.test.ts
```

Expected: FAIL because the tables do not exist.

**Step 3: Add shared types**

Create `shared/knowledge.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */

export type KnowledgeSourceKind = 'cue' | 'insight_summary' | 'insight_bullet' | 'insight_chapter';
export type KnowledgeScopeKind = 'all' | 'videos' | 'current';

export interface KnowledgeScope {
  kind: KnowledgeScopeKind;
  videoShas?: string[];
}

export interface KnowledgeSearchResult {
  chunkId: string;
  videoSha: string;
  title: string;
  sourceKind: KnowledgeSourceKind;
  lang: string | null;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  snippet: string;
}

export interface KnowledgeSource extends KnowledgeSearchResult {
  index: number;
  text: string;
}

export interface KnowledgeAskRequest {
  question: string;
  scope: KnowledgeScope;
}

export interface KnowledgeAskDone {
  answer: string;
  sources: KnowledgeSource[];
  historyId: string;
}
```

**Step 4: Add migration**

In `server/utils/db.ts`, after the current latest migration, add the next `user_version` block. If batch processing has already advanced the schema, use the next available version number.

```ts
if (version < 13) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      video_sha       TEXT NOT NULL REFERENCES videos(sha256),
      source_kind     TEXT NOT NULL,
      lang            TEXT,
      speaker_id      TEXT,
      speaker_name    TEXT,
      start_ms        INTEGER,
      end_ms          INTEGER,
      text            TEXT NOT NULL,
      search_text      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_video
      ON knowledge_chunks(video_sha, source_kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      search_text,
      title,
      speaker,
      content='',
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS qa_history (
      id              TEXT PRIMARY KEY,
      question        TEXT NOT NULL,
      answer          TEXT NOT NULL,
      scope_json      TEXT NOT NULL,
      sources_json    TEXT NOT NULL,
      model           TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_qa_history_created
      ON qa_history(created_at DESC);
  `);
  db.pragma('user_version = 13');
}
```

Use an external-content-free FTS table (`content=''`) so deletes/rebuilds stay explicit and predictable.

**Step 5: Update row types**

Add to `server/types/db.ts`:

```ts
export interface KnowledgeChunkRow {
  rowid: number;
  id: string;
  video_sha: string;
  source_kind: string;
  lang: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
  search_text: string;
  created_at: number;
  updated_at: number;
}

export interface QaHistoryRow {
  id: string;
  question: string;
  answer: string;
  scope_json: string;
  sources_json: string;
  model: string;
  created_at: number;
}
```

If `ChunkRow` is stale after diarization migrations, also add `speaker_timeline: string | null` and `raw_speaker_timeline: string | null`.

**Step 6: Run the test**

```bash
pnpm test:run server/utils/__tests__/knowledge-schema.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add server/utils/db.ts server/types/db.ts shared/knowledge.ts server/utils/__tests__/knowledge-schema.test.ts
git commit -m "feat: add knowledge base schema"
```

---

## Task 2: Build Knowledge Indexer

**Files:**
- Create: `server/utils/knowledgeIndex.ts`
- Test: `server/utils/__tests__/knowledge-index.test.ts`

**Step 1: Write failing tests**

Create tests that seed one video, one completed transcribe task, and two chunks. Verify:

- `reindexVideo(hash)` creates one knowledge row per cue.
- Re-running `reindexVideo(hash)` replaces old rows instead of duplicating.
- `deleteKnowledgeForVideo(hash)` removes both base rows and FTS rows.
- Insight summary rows are included when `insights.json` exists.

Test skeleton:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HASH = 'a'.repeat(64);
let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'subcast-knowledge-index-'));
  process.env.SUBCAST_HOME = home;
});

afterEach(async () => {
  const { closeDb } = await import('../db');
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUBCAST_HOME;
  vi.resetModules();
});

async function seedVideo() {
  const { getDb, SUBCAST_PATHS } = await import('../db');
  const db = getDb();
  db.prepare(
    `INSERT INTO videos
      (sha256, original_name, ext, size_bytes, duration_s, created_at, last_opened_at)
     VALUES (?, 'interview.mp4', '.mp4', 1, 10, ?, ?)`,
  ).run(HASH, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO transcribe_tasks
      (id, video_sha, status, model, total_chunks, done_chunks, created_at, completed_at)
     VALUES ('t1', ?, 'completed', 'base', 1, 1, ?, ?)`,
  ).run(HASH, Date.now(), Date.now());
  db.prepare(
    `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json, quality, retry_count)
     VALUES ('t1', 0, 0, 5000, ?, 'ok', 0)`,
  ).run(JSON.stringify([
    { startMs: 0, endMs: 1000, text: 'pricing came up here' },
    { startMs: 1200, endMs: 2400, text: 'customer asked for offline mode' },
  ]));
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
}

describe('knowledge index', () => {
  it('indexes transcript cues idempotently', async () => {
    await seedVideo();
    const { getDb } = await import('../db');
    const { reindexVideo } = await import('../knowledgeIndex');

    expect(reindexVideo(HASH).indexedChunks).toBe(2);
    expect(reindexVideo(HASH).indexedChunks).toBe(2);

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE video_sha=?`)
      .get(HASH) as { n: number };
    expect(count.n).toBe(2);
  });

  it('indexes cached insights when present', async () => {
    await seedVideo();
    const { SUBCAST_PATHS, getDb } = await import('../db');
    writeFileSync(
      join(SUBCAST_PATHS.cache, HASH, 'insights.json'),
      JSON.stringify({
        summary: 'The interview focused on pricing.',
        summaryBullets: ['Offline mode mattered.'],
        chapters: [{ startMs: 0, title: 'Pricing', description: 'Pricing discussion.' }],
      }),
    );
    const { reindexVideo } = await import('../knowledgeIndex');
    reindexVideo(HASH);
    const kinds = getDb()
      .prepare(`SELECT source_kind FROM knowledge_chunks WHERE video_sha=? ORDER BY source_kind`)
      .all(HASH) as Array<{ source_kind: string }>;
    expect(kinds.map((r) => r.source_kind)).toContain('insight_summary');
    expect(kinds.map((r) => r.source_kind)).toContain('insight_bullet');
    expect(kinds.map((r) => r.source_kind)).toContain('insight_chapter');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm test:run server/utils/__tests__/knowledge-index.test.ts
```

Expected: FAIL because `knowledgeIndex` does not exist.

**Step 3: Implement `server/utils/knowledgeIndex.ts`**

Core API:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from './db';
import type { Cue } from './vtt';
import type { KnowledgeSourceKind } from '#shared/knowledge';

interface InsightFile {
  summary?: string;
  summaryBullets?: string[];
  chapters?: Array<{ startMs: number; title: string; description?: string }>;
}

interface IndexRow {
  sourceKind: KnowledgeSourceKind;
  lang: string | null;
  speakerId: string | null;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
}

export interface ReindexResult {
  videoSha: string;
  indexedChunks: number;
}

export function deleteKnowledgeForVideo(videoSha: string): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT rowid FROM knowledge_chunks WHERE video_sha=?`)
    .all(videoSha) as Array<{ rowid: number }>;
  const tx = db.transaction(() => {
    for (const row of rows) {
      db.prepare(`DELETE FROM knowledge_chunks_fts WHERE rowid=?`).run(row.rowid);
    }
    db.prepare(`DELETE FROM knowledge_chunks WHERE video_sha=?`).run(videoSha);
  });
  tx();
}

export function reindexVideo(videoSha: string): ReindexResult {
  const db = getDb();
  const video = db
    .prepare(`SELECT original_name, display_name FROM videos WHERE sha256=? AND deleted_at IS NULL`)
    .get(videoSha) as { original_name: string; display_name: string | null } | undefined;
  if (!video) return { videoSha, indexedChunks: 0 };

  const rows = collectRows(videoSha);
  const title = video.display_name ?? video.original_name;
  const now = Date.now();
  const tx = db.transaction(() => {
    deleteKnowledgeForVideo(videoSha);
    const insert = db.prepare(
      `INSERT INTO knowledge_chunks
        (id, video_sha, source_kind, lang, speaker_id, speaker_name, start_ms, end_ms, text, search_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO knowledge_chunks_fts (rowid, text, title, speaker) VALUES (?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const id = randomUUID();
      const result = insert.run(
        id,
        videoSha,
        row.sourceKind,
        row.lang,
        row.speakerId,
        row.speakerName,
        row.startMs,
        row.endMs,
        row.text,
        buildSearchText(row.text),
        now,
        now,
      );
      insertFts.run(Number(result.lastInsertRowid), buildSearchText(row.text), title, row.speakerName ?? row.speakerId ?? '');
    }
  });
  tx();
  return { videoSha, indexedChunks: rows.length };
}

function collectRows(videoSha: string): IndexRow[] {
  return [
    ...collectCueRows(videoSha),
    ...collectInsightRows(videoSha),
  ].filter((row) => row.text.trim().length > 0);
}

function collectCueRows(videoSha: string): IndexRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.cues_json
       FROM transcribe_tasks t
       JOIN chunks c ON c.task_id = t.id
       WHERE t.video_sha=? AND t.status='completed'
       ORDER BY c.chunk_idx ASC`,
    )
    .all(videoSha) as Array<{ cues_json: string }>;
  const out: IndexRow[] = [];
  for (const row of rows) {
    const cues = JSON.parse(row.cues_json) as Cue[];
    for (const cue of cues) {
      out.push({
        sourceKind: 'cue',
        lang: 'original',
        speakerId: null,
        speakerName: null,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
      });
    }
  }
  return out;
}

function collectInsightRows(videoSha: string): IndexRow[] {
  const path = join(SUBCAST_PATHS.cache, videoSha, 'insights.json');
  if (!existsSync(path)) return [];
  let parsed: InsightFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as InsightFile;
  } catch {
    return [];
  }
  const rows: IndexRow[] = [];
  if (parsed.summary) {
    rows.push({
      sourceKind: 'insight_summary',
      lang: null,
      speakerId: null,
      speakerName: null,
      startMs: null,
      endMs: null,
      text: parsed.summary,
    });
  }
  for (const bullet of parsed.summaryBullets ?? []) {
    rows.push({
      sourceKind: 'insight_bullet',
      lang: null,
      speakerId: null,
      speakerName: null,
      startMs: null,
      endMs: null,
      text: bullet,
    });
  }
  for (const chapter of parsed.chapters ?? []) {
    rows.push({
      sourceKind: 'insight_chapter',
      lang: null,
      speakerId: null,
      speakerName: null,
      startMs: chapter.startMs,
      endMs: null,
      text: `${chapter.title}. ${chapter.description ?? ''}`,
    });
  }
  return rows;
}

export function buildSearchText(text: string): string {
  const normalized = text.toLowerCase();
  const grams = chineseNgrams(normalized, 2, 3);
  return grams.length > 0 ? `${normalized} ${grams.join(' ')}` : normalized;
}

function chineseNgrams(text: string, min: number, max: number): string[] {
  const chars = [...text].filter((ch) => /\p{Script=Han}/u.test(ch));
  const out: string[] = [];
  for (let n = min; n <= max; n++) {
    for (let i = 0; i <= chars.length - n; i++) {
      out.push(chars.slice(i, i + n).join(''));
    }
  }
  return out;
}
```

The FTS table must use the numeric `knowledge_chunks.rowid`, while API payloads should keep using the public UUID `knowledge_chunks.id`.

**Step 4: Run tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-index.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/utils/knowledgeIndex.ts server/utils/__tests__/knowledge-index.test.ts
git commit -m "feat: index local knowledge chunks"
```

---

## Task 3: Add Knowledge Search Repository And API

**Files:**
- Create: `server/utils/knowledgeSearch.ts`
- Create: `server/api/knowledge/search.get.ts`
- Test: `server/utils/__tests__/knowledge-search.test.ts`
- Test: `server/utils/__tests__/knowledge-search-api.test.ts`

**Step 1: Write search unit tests**

Seed indexed rows using `reindexVideo`, then assert:

- query returns matching cue.
- empty query returns recent indexed files/chunks.
- `scope.kind='videos'` filters to selected hashes.
- result includes title and timestamp.

**Step 2: Implement `knowledgeSearch.ts`**

Use parameterized SQL. Do not interpolate raw user query into SQL.

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { getDb } from './db';
import type { KnowledgeScope, KnowledgeSearchResult } from '#shared/knowledge';

const DEFAULT_LIMIT = 20;

export interface KnowledgeSearchInput {
  q: string;
  scope?: KnowledgeScope;
  limit?: number;
}

export function searchKnowledge(input: KnowledgeSearchInput): KnowledgeSearchResult[] {
  const q = input.q.trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 50);
  const scope = input.scope ?? { kind: 'all' };
  const { clause, params } = scopeWhere(scope);
  const db = getDb();

  if (!q) {
    return mapRows(db
      .prepare(
        `SELECT kc.id AS chunkId, kc.video_sha AS videoSha,
                COALESCE(v.display_name, v.original_name) AS title,
                kc.source_kind AS sourceKind, kc.lang, kc.speaker_id AS speakerId,
                kc.speaker_name AS speakerName, kc.start_ms AS startMs,
                kc.end_ms AS endMs, kc.text AS snippet
         FROM knowledge_chunks kc
         JOIN videos v ON v.sha256 = kc.video_sha
         WHERE v.deleted_at IS NULL ${clause}
         ORDER BY v.last_opened_at DESC, kc.start_ms ASC
         LIMIT ?`,
      )
      .all(...params, limit));
  }

  return mapRows(db
    .prepare(
      `SELECT kc.id AS chunkId, kc.video_sha AS videoSha,
              COALESCE(v.display_name, v.original_name) AS title,
              kc.source_kind AS sourceKind, kc.lang, kc.speaker_id AS speakerId,
              kc.speaker_name AS speakerName, kc.start_ms AS startMs,
              kc.end_ms AS endMs, snippet(knowledge_chunks_fts, 0, '<mark>', '</mark>', '...', 12) AS snippet
       FROM knowledge_chunks_fts fts
       JOIN knowledge_chunks kc ON kc.rowid = fts.rowid
       JOIN videos v ON v.sha256 = kc.video_sha
       WHERE knowledge_chunks_fts MATCH ? AND v.deleted_at IS NULL ${clause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(toFtsQuery(q), ...params, limit));
}

function toFtsQuery(q: string): string {
  return q
    .split(/\s+/)
    .map((part) => part.replace(/["*]/g, '').trim())
    .filter(Boolean)
    .map((part) => `"${part}"`)
    .join(' ');
}

function scopeWhere(scope: KnowledgeScope): { clause: string; params: string[] } {
  if ((scope.kind === 'videos' || scope.kind === 'current') && scope.videoShas?.length) {
    return {
      clause: `AND kc.video_sha IN (${scope.videoShas.map(() => '?').join(',')})`,
      params: scope.videoShas,
    };
  }
  return { clause: '', params: [] };
}

function mapRows(rows: unknown[]): KnowledgeSearchResult[] {
  return rows as KnowledgeSearchResult[];
}
```

Use `knowledge_chunks.rowid` for FTS joins. Keep the public `id` UUID for API payloads and history references.
For Chinese queries, `toFtsQuery()` should pass the user query through the same `buildSearchText()` helper used during indexing before tokenization.

**Step 3: Implement API**

Create `server/api/knowledge/search.get.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { searchKnowledge } from '../../utils/knowledgeSearch';
import { isValidHash } from '../../utils/validate';
import type { KnowledgeScope } from '#shared/knowledge';

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const query = typeof q.q === 'string' ? q.q : '';
  const hashes = typeof q.hashes === 'string'
    ? q.hashes.split(',').filter(isValidHash)
    : [];
  const scope: KnowledgeScope = hashes.length > 0
    ? { kind: 'videos', videoShas: hashes }
    : { kind: 'all' };
  const limit = typeof q.limit === 'string' ? Number(q.limit) : undefined;
  return { items: searchKnowledge({ q: query, scope, limit }) };
});
```

**Step 4: Run tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-search.test.ts server/utils/__tests__/knowledge-search-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/utils/knowledgeSearch.ts server/api/knowledge/search.get.ts server/utils/__tests__/knowledge-search.test.ts server/utils/__tests__/knowledge-search-api.test.ts
git commit -m "feat: add local knowledge search"
```

---

## Task 4: Wire Indexing Into Transcript And Insight Completion

**Files:**
- Modify: `server/utils/queue.ts`
- Modify: `server/utils/insightTasks.ts`
- Test: extend `server/utils/__tests__/queue.test.ts` or add `server/utils/__tests__/knowledge-index-hooks.test.ts`

**Step 1: Add test coverage**

Mock or seed the DB so a completed transcript path calls `reindexVideo(videoSha)`. Keep this test narrow; do not run Whisper.

If queue tests are too heavy, test a small exported helper:

```ts
export function reindexAfterDerivedArtifact(videoSha: string): void {
  try {
    reindexVideo(videoSha);
  } catch (err) {
    logEvent({ level: 'warn', event: 'knowledge_reindex_failed', videoSha, error: ... });
  }
}
```

**Step 2: Implement helper**

Add to `server/utils/knowledgeIndex.ts`:

```ts
import { logEvent } from './log';

export function reindexVideoBestEffort(videoSha: string, reason: string): void {
  try {
    const result = reindexVideo(videoSha);
    logEvent({
      level: 'info',
      event: 'knowledge_reindexed',
      videoSha,
      reason,
      indexedChunks: result.indexedChunks,
    });
  } catch (err) {
    logEvent({
      level: 'warn',
      event: 'knowledge_reindex_failed',
      videoSha,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

Ensure `logEvent` does not include transcript text.

**Step 3: Call helper after transcript completes**

In `server/utils/queue.ts`, after `original.vtt` and `subtitles` are written and before/after task status completes:

```ts
import { reindexVideoBestEffort } from './knowledgeIndex';
```

Then:

```ts
reindexVideoBestEffort(videoSha, 'transcribe_completed');
```

**Step 4: Call helper after insights complete**

In `server/utils/insightTasks.ts`, after `insights.json` is written and before emitting `done`:

```ts
import { reindexVideoBestEffort } from './knowledgeIndex';
```

Then:

```ts
reindexVideoBestEffort(videoSha, 'insights_completed');
```

**Step 5: Run focused tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-index.test.ts server/utils/__tests__/knowledge-index-hooks.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/utils/queue.ts server/utils/insightTasks.ts server/utils/knowledgeIndex.ts server/utils/__tests__/knowledge-index-hooks.test.ts
git commit -m "feat: refresh knowledge index after derived artifacts"
```

---

## Task 5: Add Deletion And Reindex APIs

**Files:**
- Create: `server/api/knowledge/reindex.post.ts`
- Create: `server/api/knowledge/reindex/[hash].post.ts`
- Modify: `server/utils/mediaGraphDelete.ts`
- Test: `server/utils/__tests__/knowledge-reindex-api.test.ts`
- Test: extend `server/utils/__tests__/mediaGraphDelete.test.ts`

**Step 1: Implement API tests**

Verify:

- `POST /api/knowledge/reindex/:hash` reindexes one video.
- `POST /api/knowledge/reindex` reindexes all non-deleted videos.
- Deleting a video removes `knowledge_chunks`.

**Step 2: Add all-library reindex helper**

In `server/utils/knowledgeIndex.ts`:

```ts
export function reindexAllVideos(): { total: number; indexedChunks: number } {
  const db = getDb();
  const rows = db
    .prepare(`SELECT sha256 FROM videos WHERE deleted_at IS NULL ORDER BY last_opened_at DESC`)
    .all() as Array<{ sha256: string }>;
  let indexedChunks = 0;
  for (const row of rows) {
    indexedChunks += reindexVideo(row.sha256).indexedChunks;
  }
  return { total: rows.length, indexedChunks };
}
```

**Step 3: Create reindex endpoints**

`server/api/knowledge/reindex.post.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { reindexAllVideos } from '../../utils/knowledgeIndex';

export default defineEventHandler(() => {
  return reindexAllVideos();
});
```

`server/api/knowledge/reindex/[hash].post.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { reindexVideo } from '../../../utils/knowledgeIndex';
import { isValidHash } from '../../../utils/validate';

export default defineEventHandler((event) => {
  const hash = String(event.context.params?.hash ?? '');
  if (!isValidHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }
  return reindexVideo(hash);
});
```

**Step 4: Integrate deletion**

In `server/utils/mediaGraphDelete.ts`, import and call:

```ts
import { deleteKnowledgeForVideo } from './knowledgeIndex';
```

When deleting a specific video, call:

```ts
deleteKnowledgeForVideo(hash);
```

When clearing all, delete from both `knowledge_chunks_fts` and `knowledge_chunks` in the same transaction. If importing the helper creates transaction nesting issues, perform direct SQL deletes in `mediaGraphDelete.ts`.

**Step 5: Run tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-reindex-api.test.ts server/utils/__tests__/mediaGraphDelete.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/api/knowledge/reindex.post.ts server/api/knowledge/reindex/[hash].post.ts server/utils/mediaGraphDelete.ts server/utils/knowledgeIndex.ts server/utils/__tests__/knowledge-reindex-api.test.ts server/utils/__tests__/mediaGraphDelete.test.ts
git commit -m "feat: keep knowledge index in sync with media graph"
```

---

## Task 6: Build Knowledge Ask Prompt And History Helpers

**Files:**
- Create: `server/utils/knowledgeAsk.ts`
- Test: `server/utils/__tests__/knowledge-ask.test.ts`

**Step 1: Write failing tests**

Test:

- `buildKnowledgeMessages` includes only provided sources, not all transcript text.
- Empty sources produce a deterministic “not enough evidence” answer path.
- `saveQaHistory` writes sources JSON and can list/delete history.

**Step 2: Implement prompt builder**

Create `server/utils/knowledgeAsk.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import type { LLMMessage } from './llmClient';
import type {
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeAskDone,
} from '#shared/knowledge';

export function buildKnowledgeMessages(
  question: string,
  sources: readonly KnowledgeSource[],
): LLMMessage[] {
  const system = [
    'You answer questions about a local media transcript library.',
    'Use only the SOURCES provided by the user.',
    'If the sources are insufficient, say you cannot determine the answer from the library.',
    'Do not invent file names, timestamps, speakers, or facts.',
    'When useful, cite sources using [1], [2], etc.',
  ].join('\n');
  const sourceText = sources.length === 0
    ? 'NO SOURCES FOUND.'
    : sources.map((s) => [
        `[${s.index}] ${s.title}`,
        s.startMs !== null ? `time: ${formatTime(s.startMs)}` : 'time: n/a',
        s.speakerName || s.speakerId ? `speaker: ${s.speakerName ?? s.speakerId}` : 'speaker: n/a',
        `text: ${s.text}`,
      ].join('\n')).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `QUESTION:\n${question}\n\nSOURCES:\n${sourceText}` },
  ];
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function saveQaHistory(input: {
  question: string;
  answer: string;
  scope: KnowledgeScope;
  sources: KnowledgeSource[];
  model: string;
}): KnowledgeAskDone {
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO qa_history (id, question, answer, scope_json, sources_json, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.question,
    input.answer,
    JSON.stringify(input.scope),
    JSON.stringify(input.sources),
    input.model,
    Date.now(),
  );
  return { historyId: id, answer: input.answer, sources: input.sources };
}
```

**Step 3: Add history helpers**

Add:

```ts
export function listQaHistory(limit = 50) { ... }
export function deleteQaHistory(id: string): boolean { ... }
```

Keep the return shape UI-friendly and do not include transcript chunks beyond stored sources.

**Step 4: Run tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-ask.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/utils/knowledgeAsk.ts server/utils/__tests__/knowledge-ask.test.ts
git commit -m "feat: add local knowledge question helpers"
```

---

## Task 7: Add Knowledge Ask To `llmQueue` And SSE API

**Files:**
- Modify: `server/utils/queue.ts`
- Create: `server/utils/knowledgeAskTasks.ts`
- Create: `server/api/knowledge/ask.post.ts`
- Create: `server/api/knowledge/ask/[id].delete.ts`
- Create: `server/api/knowledge/history.get.ts`
- Create: `server/api/knowledge/history/[id].delete.ts`
- Test: `server/utils/__tests__/knowledge-ask-api.test.ts`

**Step 1: Write API tests**

Mock `llmBackend().chatStream()` through the queue worker seam. Verify SSE emits:

1. `retrieval`
2. `start`
3. `token`
4. `done`

Also verify no sources returns an error or a no-evidence answer without crashing.

**Step 2: Extend `llmQueue` task model**

In `server/utils/queue.ts`, extend the LLM task kind:

```ts
type LLMTaskKind = 'translate' | 'insight' | 'knowledge_ask';
```

Add a `knowledge_ask_tasks` table in Task 1 or a follow-up migration before this task:

```sql
CREATE TABLE IF NOT EXISTS knowledge_ask_tasks (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL, -- queued | running | done | error | canceled
  question      TEXT NOT NULL,
  scope_json    TEXT NOT NULL,
  sources_json  TEXT NOT NULL,
  answer        TEXT,
  model         TEXT NOT NULL,
  error_msg     TEXT,
  error_code    TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_knowledge_ask_status
  ON knowledge_ask_tasks(status, created_at);
```

Then add:

- `llmQueue.ensureKnowledgeAskTask(question, scope, sources, model)`
- `startKnowledgeAsk(taskId)`
- `attachKnowledgeAsk(taskId)`
- cancel handling in `llmQueue.cancel(taskId)`
- the queued-task `UNION ALL` branch in `tryStartNext()`

**Step 3: Implement `runKnowledgeAskWorker`**

Create `server/utils/knowledgeAskTasks.ts`. It should mirror `runInsightWorker`, but:

- builds messages with `buildKnowledgeMessages(question, sources)`
- emits `retrieval` before generation or has `attachKnowledgeAsk` replay stored sources first
- emits `token` frames while streaming
- writes `knowledge_ask_tasks.answer`
- calls `saveQaHistory()` on success
- emits `done` with `{ answer, sources, historyId }`
- never logs raw question, answer, or source snippets

**Step 4: Implement `POST /api/knowledge/ask`**

The route should:

1. Parse `{ question, scope }`.
2. Run `searchKnowledge({ q: question, scope, limit: 12 })`.
3. Convert results to numbered sources.
4. Create an `llmQueue` knowledge ask task.
5. `tryStartNext()`.
6. Stream `llmQueue.attach(task.id)` using `setupSseStream()` and `formatSse()`, same shape as `server/api/translate.get.ts`.

Do not call `llmBackend().chatStream()` directly from this API.

**Step 5: Implement cancel endpoint**

`server/api/knowledge/ask/[id].delete.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { llmQueue } from '../../../utils/queue';

export default defineEventHandler((event) => {
  const id = String(event.context.params?.id ?? '');
  return { ok: llmQueue.cancel(id) };
});
```

**Step 6: Implement history endpoints**

Use `listQaHistory` and `deleteQaHistory` from `knowledgeAsk.ts`.

**Step 7: Run tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-ask-api.test.ts
```

Expected: PASS.

**Step 8: Commit**

```bash
git add server/api/knowledge server/utils/queue.ts server/utils/knowledgeAsk.ts server/utils/knowledgeAskTasks.ts server/utils/__tests__/knowledge-ask-api.test.ts
git commit -m "feat: answer local knowledge questions"
```

---

## Task 8: Add Player Deep-Link Seek

**Files:**
- Modify: `app/pages/player/[hash].vue`
- Test: manual browser verification

**Step 1: Add query seek on mount**

In `app/pages/player/[hash].vue`, parse `route.query.t`. Apply after metadata loads, because setting `currentTime` too early can be ignored by some media elements.

Add helper:

```ts
const pendingInitialSeekMs = computed(() => {
  const raw = route.query.t;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
});
```

After `onLoadedMetadata` or in a watcher for `duration`, call:

```ts
watch(duration, (d) => {
  const ms = pendingInitialSeekMs.value;
  const v = videoRef.value;
  if (!v || ms === null || d <= 0) return;
  v.currentTime = Math.min(ms / 1000, d);
}, { once: true });
```

If Vue version does not support `{ once: true }`, use a `didInitialSeek` ref.

**Step 2: Verify manually**

Run:

```bash
pnpm dev
```

Open a known video URL:

```txt
http://localhost:3000/player/<hash>?t=12000
```

Expected: video seeks to roughly 12 seconds after metadata loads.

**Step 3: Commit**

```bash
git add app/pages/player/[hash].vue
git commit -m "feat: support timestamp links into player"
```

---

## Task 9: Build Knowledge Page UI

**Files:**
- Create: `app/pages/knowledge.vue`
- Create: `app/composables/useKnowledgeSearch.ts`
- Modify: `app/components/AppHeader.vue`
- Modify: `i18n/locales/en.json`
- Modify: `i18n/locales/zh-CN.json`
- Test: manual browser verification

**Step 1: Add composable**

Create `app/composables/useKnowledgeSearch.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import type { KnowledgeSearchResult } from '#shared/knowledge';

export function useKnowledgeSearch() {
  const query = ref('');
  const items = ref<KnowledgeSearchResult[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function search() {
    loading.value = true;
    error.value = null;
    try {
      const res = await $fetch<{ items: KnowledgeSearchResult[] }>('/api/knowledge/search', {
        query: { q: query.value },
      });
      items.value = res.items;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'search failed';
    } finally {
      loading.value = false;
    }
  }

  return { query, items, loading, error, search };
}
```

**Step 2: Create Knowledge page**

The page should be functional, not a landing page:

- Search input at top.
- Results list on left or top.
- Ask textarea / button.
- Streaming answer panel.
- Sources list with links to `/player/${source.videoSha}?t=${source.startMs ?? 0}`.

Use existing UI components (`Button`, `Input`, `Alert`, `Tabs` if useful) and lucide icons.

Implementation outline:

```vue
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { Search, Send, X } from 'lucide-vue-next';
import type { KnowledgeSource } from '#shared/knowledge';

const { t } = useI18n();
const { query, items, loading, error, search } = useKnowledgeSearch();
const question = ref('');
const answer = ref('');
const sources = ref<KnowledgeSource[]>([]);
const asking = ref(false);
let esAbort: AbortController | null = null;

async function ask() {
  if (!question.value.trim() || asking.value) return;
  asking.value = true;
  answer.value = '';
  sources.value = [];
  const res = await fetch('/api/knowledge/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: question.value, scope: { kind: 'all' } }),
  });
  // Parse SSE stream with a tiny reader helper, or factor out an existing one
  // if the app already has an SSE composable.
}
</script>
```

If no generic SSE POST helper exists, implement a small local `readSseResponse(res, handlers)` utility inside the component or a composable. EventSource cannot POST JSON.

**Step 3: Add nav link**

In `app/components/AppHeader.vue`, add `BookOpen` or `Search` icon and a `NuxtLink` to `/knowledge`.

Add i18n keys:

```json
{
  "app": {
    "knowledge": "Knowledge"
  },
  "knowledge": {
    "title": "Knowledge",
    "subtitle": "Search and ask questions across local transcripts.",
    "searchPlaceholder": "Search transcripts...",
    "askPlaceholder": "Ask about your local media library...",
    "ask": "Ask",
    "sources": "Sources",
    "empty": "Transcribe files to build your local knowledge base."
  }
}
```

Chinese:

```json
{
  "app": {
    "knowledge": "知识库"
  },
  "knowledge": {
    "title": "知识库",
    "subtitle": "搜索本地转录，并跨文件提问。",
    "searchPlaceholder": "搜索字幕内容...",
    "askPlaceholder": "向本地媒体库提问...",
    "ask": "提问",
    "sources": "来源",
    "empty": "转录文件后即可建立本地知识库。"
  }
}
```

**Step 4: Manual verification**

```bash
pnpm dev
```

Verify:

- Header shows Knowledge nav.
- Search returns seeded/indexed content.
- Ask streams answer.
- Source click opens player and seeks.
- Empty library has a useful empty state.

**Step 5: Commit**

```bash
git add app/pages/knowledge.vue app/composables/useKnowledgeSearch.ts app/components/AppHeader.vue i18n/locales/en.json i18n/locales/zh-CN.json
git commit -m "feat: add knowledge workbench"
```

---

## Task 10: Add Privacy Guardrails And Diagnostics Tests

**Files:**
- Modify: `server/api/diagnostic.get.ts` only if needed
- Test: `server/utils/__tests__/knowledge-privacy.test.ts`
- Test: existing `server/utils/__tests__/logSanitize.test.ts` if new log fields are introduced

**Step 1: Write privacy test**

Seed:

- `knowledge_chunks.text = 'secret transcript phrase'`
- `qa_history.question = 'secret question'`
- `qa_history.answer = 'secret answer'`

Call diagnostics handler and inspect zip contents. Verify those strings are absent.

**Step 2: Adjust diagnostics if needed**

Current diagnostics endpoint includes manifest/settings/hardware/models/logs only. It should already exclude DB tables. If tests pass without changes, do not edit production code.

If future code adds DB summaries to diagnostics, ensure it only includes counts:

```json
{
  "knowledge": {
    "indexedChunks": 123,
    "qaHistoryCount": 4
  }
}
```

Never include `knowledge_chunks.text`, `qa_history.question`, or `qa_history.answer` by default.

**Step 3: Audit logs**

Search:

```bash
rg -n "knowledge_|qa_|question|answer|snippet|sources" server
```

Ensure logs include counts, hashes, durations, and error codes only.

**Step 4: Run tests**

```bash
pnpm test:run server/utils/__tests__/knowledge-privacy.test.ts server/utils/__tests__/logSanitize.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/utils/__tests__/knowledge-privacy.test.ts server/api/diagnostic.get.ts server/utils/__tests__/logSanitize.test.ts
git commit -m "test: protect knowledge content in diagnostics"
```

---

## Task 11: End-To-End Verification

**Files:**
- Modify only if verification finds bugs.

**Step 1: Run focused tests**

```bash
pnpm test:run \
  server/utils/__tests__/knowledge-schema.test.ts \
  server/utils/__tests__/knowledge-index.test.ts \
  server/utils/__tests__/knowledge-search.test.ts \
  server/utils/__tests__/knowledge-search-api.test.ts \
  server/utils/__tests__/knowledge-ask.test.ts \
  server/utils/__tests__/knowledge-ask-api.test.ts \
  server/utils/__tests__/knowledge-privacy.test.ts
```

Expected: PASS.

**Step 2: Run broader checks**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: PASS.

**Step 3: Manual smoke**

```bash
pnpm dev
```

Manual flow:

1. Import or use an existing completed video.
2. Run `POST /api/knowledge/reindex/<hash>` if needed.
3. Open `/knowledge`.
4. Search for a known transcript phrase.
5. Ask a question whose answer appears in the transcript.
6. Confirm answer cites sources.
7. Click a source; confirm player opens at timestamp.
8. Delete the video; confirm search no longer returns it.

**Step 4: Update docs**

Add a short section to `README.md` and `README.zh.md` only after the feature is stable. Mention:

- Local knowledge search.
- Local question answering.
- Source citations.
- No cloud upload.

**Step 5: Final commit**

```bash
git add README.md README.zh.md
git commit -m "docs: describe local knowledge qa"
```

---

## Implementation Notes

### FTS Row IDs

SQLite FTS `rowid` is numeric. The plan intentionally uses
`knowledge_chunks.rowid INTEGER PRIMARY KEY AUTOINCREMENT` for FTS joins and
keeps `knowledge_chunks.id` as a public UUID. Do not insert UUID strings into
`knowledge_chunks_fts.rowid`.

### Chinese Search

FTS5 `unicode61` is weak for Chinese segmentation. v0.4.0 must generate Chinese 2-gram / 3-gram tokens at index time and apply the same normalization to Chinese queries. Add tests with Chinese transcript text such as `用户觉得价格太高` and queries like `价格` / `太高`.

### LLM Queue Choice

Knowledge ask must reuse `llmQueue` as a third `LLMTaskKind = 'knowledge_ask'`. Do not stream directly from `llmBackend()` in `/api/knowledge/ask`, because translation, insights, and knowledge ask need one shared local-model scheduler.

### Privacy

Do not log:

- raw question text
- answer text
- source snippets
- transcript chunks
- filenames in non-debug logs

Safe logs:

- video hash
- counts
- durations
- error codes
- source count
- prompt character count

### UI Scope

v0.4.0 supports all-library scope, current search results, and manually selected files. Current-file scope can be added from the player later with a link like `/knowledge?hash=<hash>`.

Do not add tags, embeddings, saved collections, or workflow templates until the Phase 1 loop is stable.
