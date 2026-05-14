# LLM Queue / Insight Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge AI-summary (insight) tasks into a shared `LLMQueue` with translate (single-worker, FIFO across both `translate_tasks` and `insight_tasks`), so insights show up on the home tasks panel with first-class status / error visibility and llama-server gets coordinated access.

**Architecture:** Introduce `LLMQueue` in `server/utils/queue.ts`. It owns one active slot, dequeues from both translate and insight tables ordered by `created_at`, and dispatches to `runTranslateWorker` / `runInsightWorker` based on task kind. The existing `translateQueue` export becomes a thin facade so call sites don't change wholesale. The in-memory `tasks: Map` and `void runGeneration()` flow in `insightTasks.ts` is replaced by DB-backed `ensureInsightTask` + queue dequeue. Transcribe stays on its own queue.

**Tech Stack:** Nuxt 4 + Nitro server, Vue 3 + TypeScript strict, better-sqlite3, vitest, h3 SSE handlers, llama-server (single in-process model).

**Spec:** `docs/superpowers/specs/2026-05-14-llm-queue-insight-integration-design.md`

---

## File Structure

**New**
- `server/api/queue/insight/[id].delete.ts` — explicit cancel endpoint for insights
- `server/utils/__tests__/llm-queue.test.ts` — LLMQueue dequeue + dedup + resurrection + cross-kind FIFO

**Modified**
- `server/utils/queue.ts` — add `LLMQueue` class + `llmQueue` singleton; convert `translateQueue` to thin facade
- `server/utils/insightTasks.ts` — extract `runInsightWorker(active, params)`; drop in-memory map and detached entry points
- `server/api/insights.get.ts` — replace direct `startTask()` with `ensureInsightTask + llmQueue.attach`; emit `status: 'queued'`
- `server/api/insights/[id].delete.ts` — collapse to `llmQueue.cancel(id)` proxy
- `server/api/queue/list.get.ts` — add insight kind to merged item list
- `server/plugins/00.queue.ts` — switch to `llmQueue.tryStartNext()`
- `server/plugins/02.recover-zombie-tasks.ts` — switch to `llmQueue.tryStartNext()`
- `server/api/desktop/shutdown.post.ts` — drop `abortAllInsightTasks`; switch to `llmQueue.cancelActive()`
- `server/api/transcribe/retry.post.ts` — replace `getTaskByHash + abortTask` with DB query + `llmQueue.cancel`
- `server/api/cache/list.get.ts` — replace `getTaskByHash` check with DB EXISTS query
- `server/api/cache/[hash].delete.ts` — replace `getTaskByHash + abortTask` with DB query + `llmQueue.cancel`
- `server/utils/__tests__/queue.test.ts` — keep translate tests (run via facade); add insight + cross-kind tests
- `app/pages/index.vue` — render insight branch in tasks panel; add cancel handler

**Removed (from `server/utils/insightTasks.ts`)**
- `tasks: Map<string, InsightTask>`
- `getTaskByHash`, `getTaskById`
- `startTask`, `abortTask`, `abortAllInsightTasks`
- `scheduleEviction`
- `InsightTask` interface (in-memory shape)

---

## Conventions

- Tests under `server/utils/__tests__/`, picked up by `vitest.config.ts` glob
- Server errors use `createError({ statusCode, statusMessage })`
- All h3 helpers explicitly imported from `'h3'`
- Each slice ends with a commit; system stays runnable after every slice
- Subcast policy: no decorative comments; only WHY-comments for non-obvious invariants
- No new npm dependencies

---

## Slice 1: `LLMQueue` skeleton + `ensureInsightTask`

This slice introduces the new class and the insight-side dedup helper, but does NOT yet wire up workers. After this slice, `LLMQueue` exists alongside the legacy code but isn't used by API endpoints.

**Files:**
- Modify: `server/utils/queue.ts`
- Create: `server/utils/__tests__/llm-queue.test.ts`

- [ ] **Step 1: Add type for queued LLM task at the top of `queue.ts` (after imports)**

```ts
type LLMTaskKind = 'translate' | 'insight';

interface ActiveLLMTask {
  taskId: string;
  kind: LLMTaskKind;
  videoSha: string;
  emitter: EventEmitter;
  abort: AbortController;
  donePromise: Promise<void>;
  // translate-specific live state (used by runTranslateWorker only)
  doneCues?: Cue[];
  lang?: string;
  model?: string;
}
```

- [ ] **Step 2: Add `LLMQueue` skeleton class (after the existing `TranslateQueue` class)**

```ts
class LLMQueue {
  private active: ActiveLLMTask | null = null;

  /**
   * Returns the canonical insight task row for `(videoSha, uiLanguage)`,
   * creating one if none exists. Symmetric resurrection contract with
   * TranslateQueue.ensureTask: error/canceled rows flip back to queued.
   */
  ensureInsightTask(
    videoSha: string,
    uiLanguage: 'zh-CN' | 'en',
    model: string,
  ): InsightTaskSummary {
    const db = getDb();
    const existing = db
      .prepare(
        `SELECT id, video_sha, status, model, ui_language, error_msg
         FROM insight_tasks WHERE video_sha = ? AND ui_language = ?`,
      )
      .get(videoSha, uiLanguage) as InsightTaskSummary | undefined;
    if (existing) {
      if (existing.status === 'error' || existing.status === 'canceled') {
        db.prepare(
          `UPDATE insight_tasks SET status='queued', error_msg=NULL WHERE id=?`,
        ).run(existing.id);
        logEvent({
          level: 'info',
          event: 'insight_resurrected',
          taskId: existing.id,
          fromStatus: existing.status,
        });
        existing.status = 'queued';
        existing.error_msg = null;
      }
      return existing;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO insight_tasks (id, video_sha, status, model, ui_language, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    ).run(id, videoSha, model, uiLanguage, Date.now());
    return {
      id,
      video_sha: videoSha,
      status: 'queued',
      model,
      ui_language: uiLanguage,
      error_msg: null,
    };
  }

  // tryStartNext / runTranslateWorker / runInsightWorker / attach / cancel /
  // cancelActive — added in subsequent slices.
}

export const llmQueue = new LLMQueue();
```

- [ ] **Step 3: Add `InsightTaskSummary` type + import `InsightTaskRow` at the top of `queue.ts`**

In the existing imports block:
```ts
import type {
  ChunkRow,
  InsightTaskRow,
  TranscribeTaskRow,
  TranslateTaskRow,
  VideoRow,
} from '../types/db';
```

After the `TranslateTaskSummary` declaration:
```ts
export type InsightTaskSummary = Pick<
  InsightTaskRow,
  'id' | 'video_sha' | 'status' | 'model' | 'ui_language' | 'error_msg'
>;
```

- [ ] **Step 4: Verify `InsightTaskRow` exists in `server/types/db.ts`. If not, add:**

```ts
export interface InsightTaskRow {
  id: string;
  video_sha: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  model: string;
  ui_language: 'zh-CN' | 'en';
  error_msg: string | null;
  created_at: number;
  completed_at: number | null;
}
```

- [ ] **Step 5: Write failing test for ensureInsightTask dedup**

Create `server/utils/__tests__/llm-queue.test.ts`:

```ts
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
    `INSERT INTO videos (sha256, original_name, ext, bytes, added_at)
     VALUES (?, 'a.mp4', '.mp4', 1, ?)`,
  ).run(HASH_A, Date.now());
});

afterEach(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.SUBCAST_HOME;
});

describe('llmQueue.ensureInsightTask', () => {
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
});
```

- [ ] **Step 6: Run tests; confirm 5 pass**

Run: `pnpm vitest run server/utils/__tests__/llm-queue.test.ts`
Expected: 5/5 pass.

- [ ] **Step 7: Run full test suite as a regression check**

Run: `pnpm test`
Expected: all pre-existing tests still pass (LLMQueue is additive in this slice).

- [ ] **Step 8: Commit**

```bash
git add server/utils/queue.ts server/utils/__tests__/llm-queue.test.ts server/types/db.ts
git commit -m "feat(queue): scaffold LLMQueue + ensureInsightTask with dedup/resurrection"
```

---

## Slice 2: Move Translate worker into `LLMQueue`; thin-facade `translateQueue`

After this slice, all translate work runs through `LLMQueue.runTranslateWorker`. The `translateQueue` export still exists as a facade so call sites at `server/api/translate.get.ts`, `server/api/queue/translate/[id].delete.ts`, `server/api/desktop/shutdown.post.ts`, `server/plugins/*.ts`, and `server/utils/__tests__/queue.test.ts` keep working unchanged.

**Files:**
- Modify: `server/utils/queue.ts`
- Modify: `server/utils/__tests__/queue.test.ts` (only if any test relies on internal state)

- [ ] **Step 1: Move the body of existing `TranslateQueue.runWorker` to a new `LLMQueue.runTranslateWorker` method**

The signature receives an `ActiveLLMTask` (with `kind: 'translate'`). Adapt field reads (`active.lang!`, `active.model!`, `active.doneCues!`). Otherwise the body is identical to current `TranslateQueue.runWorker(active: ActiveTranslateTask)`.

- [ ] **Step 2: Add `tryStartNext()` to `LLMQueue` that handles only translate for this slice**

```ts
async tryStartNext(): Promise<void> {
  if (this.active) return;
  const db = getDb();
  // Translate-only for now; insight added in Slice 3.
  const next = db
    .prepare(
      `SELECT id, video_sha, target_lang AS lang, model
       FROM translate_tasks
       WHERE status = 'queued'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string; video_sha: string; lang: string; model: string } | undefined;
  if (!next) return;
  db.prepare(`UPDATE translate_tasks SET status='running' WHERE id=?`).run(next.id);
  this.active = {
    taskId: next.id,
    kind: 'translate',
    videoSha: next.video_sha,
    lang: next.lang,
    model: next.model,
    emitter: new EventEmitter(),
    abort: new AbortController(),
    doneCues: [],
    donePromise: Promise.resolve(),
  };
  const wp = this.runTranslateWorker(this.active);
  this.active.donePromise = wp.catch(() => {});
  wp.catch((err) => {
    logEvent({
      level: 'error',
      event: 'llm_worker_crashed',
      kind: 'translate',
      taskId: next.id,
      msg: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}
```

- [ ] **Step 3: Add `attach`, `cancel`, `cancelActive`, `bumpPriority`, `ensureTask` (translate variant) to `LLMQueue`**

Move the existing implementations from `TranslateQueue` class methods, adapting to read from `this.active` (now `ActiveLLMTask | null`). `ensureTask` keeps the translate-specific signature `(videoSha, lang, model?)`. The behavior is identical to current `TranslateQueue.{ensureTask, attach, cancel, cancelActive, bumpPriority}`.

In `cancel`, broaden the SQL to handle the dispatch by kind once insight worker lands in Slice 3 — for now keep it translate-only:

```ts
cancel(taskId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT status FROM translate_tasks WHERE id = ?`)
    .get(taskId) as Pick<TranslateTaskRow, 'status'> | undefined;
  if (!row) return false;
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'canceled') {
    return false;
  }
  db.prepare(`UPDATE translate_tasks SET status='canceled' WHERE id=?`).run(taskId);
  if (this.active?.taskId === taskId) this.active.abort.abort();
  logEvent({ level: 'info', event: 'translate_canceled', taskId });
  return true;
}
```

- [ ] **Step 4: Replace the existing `class TranslateQueue { ... }` with a thin facade**

```ts
class TranslateQueueFacade {
  ensureTask(videoSha: string, lang: string, model?: string): TranslateTaskSummary {
    return llmQueue.ensureTask(videoSha, lang, model);
  }
  bumpPriority(taskId: string): void {
    llmQueue.bumpPriority(taskId);
  }
  cancel(taskId: string): boolean {
    return llmQueue.cancel(taskId);
  }
  async tryStartNext(): Promise<void> {
    return llmQueue.tryStartNext();
  }
  attach(taskId: string) {
    return llmQueue.attach(taskId);
  }
  async cancelActive(): Promise<void> {
    return llmQueue.cancelActive();
  }
}

export const translateQueue = new TranslateQueueFacade();
```

- [ ] **Step 5: Run translate tests, expect green**

Run: `pnpm vitest run server/utils/__tests__/queue.test.ts`
Expected: all existing translate tests pass via facade.

- [ ] **Step 6: Run full test suite + e2e**

Run: `pnpm test`
Expected: all pre-existing tests pass.

- [ ] **Step 7: Manual sanity (optional but recommended)**

- Start dev server: `pnpm dev`
- Trigger a translate task via the player UI
- Verify: SSE streams cues, `/api/queue/list` shows running, completes normally, `{lang}.vtt` written

- [ ] **Step 8: Commit**

```bash
git add server/utils/queue.ts server/utils/__tests__/queue.test.ts
git commit -m "refactor(queue): move translate worker into LLMQueue; translateQueue becomes facade"
```

---

## Slice 3: Move Insight worker into `LLMQueue`; refactor `/api/insights`

After this slice, insight tasks dequeue from `LLMQueue` (FIFO with translate by `created_at`, ignoring translate's `priority` field for cross-kind ordering). The in-memory `tasks: Map` is gone. `/api/insights` GET uses `ensureInsightTask + llmQueue.attach`. The endpoint emits a new `status: 'queued'` SSE frame.

**Files:**
- Modify: `server/utils/queue.ts`
- Modify: `server/utils/insightTasks.ts`
- Modify: `server/api/insights.get.ts`
- Modify: `server/utils/__tests__/llm-queue.test.ts` (add cross-kind FIFO test)

- [ ] **Step 1: In `server/utils/insightTasks.ts`, extract `runInsightWorker(active, params)` from existing `runGeneration`**

Keep the function in this file, but change its signature so the queue can call it:

```ts
export interface InsightWorkerParams {
  videoSha: string;
  model: string;
  uiLanguage: 'zh-CN' | 'en';
  messages: LLMMessage[];
  cues: readonly Cue[];
}

export async function runInsightWorker(
  active: ActiveLLMTask,
  params: InsightWorkerParams,
): Promise<void> {
  const { messages, cues, videoSha, model, uiLanguage } = params;
  const db = getDb();
  const taskId = active.taskId;
  const emit = (frame: SseFrame) => active.emitter.emit('frame', frame);
  let raw = '';
  let attempt = 0;
  const backend = llmBackend();

  while (attempt < TEMPS.length) {
    raw = '';
    try {
      const stream = backend.chatStream({
        messages,
        temperature: TEMPS[attempt]!,
        maxTokens: 4096,
        signal: active.abort.signal,
      });
      for await (const chunk of stream) {
        if (chunk.delta) {
          raw += chunk.delta;
          if (attempt === 0) emit({ event: 'token', data: { text: chunk.delta } });
        }
        if (chunk.finishReason === 'cancel') break;
      }

      const parsed = parseInsights(raw);
      const snapped: Insights = { ...parsed, chapters: snapChapters(parsed.chapters, cues) };

      const dir = join(SUBCAST_PATHS.cache, videoSha);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'insights.json'),
        JSON.stringify(
          {
            ...snapped,
            _meta: {
              ollamaModel: model,
              uiLanguage,
              originalCueCount: cues.length,
              generatedAt: Date.now(),
              rawMarkdown: raw,
            },
          },
          null,
          2,
        ),
      );

      db.prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`)
        .run(Date.now(), taskId);
      emit({ event: 'done', data: { insights: snapped, fromCache: false } });
      return;
    } catch (err) {
      attempt++;
      if (active.abort.signal.aborted) {
        db.prepare(
          `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`,
        ).run(Date.now(), taskId);
        emit({ event: 'error', data: { code: 'CANCELED' } });
        return;
      }
      if (attempt >= TEMPS.length) {
        const dir = join(SUBCAST_PATHS.cache, videoSha);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'insights.json.raw.txt'), raw);
        } catch (writeErr) {
          logEvent({
            level: 'debug',
            event: 'insights_raw_dump_failed',
            videoSha,
            taskId,
            error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        db.prepare(
          `UPDATE insight_tasks SET status='error', error_msg=?, completed_at=? WHERE id=?`,
        ).run(message, Date.now(), taskId);
        emit({ event: 'error', data: { code: 'PARSE_FAILED', message } });
        return;
      }
    }
  }
}
```

Also add at the top of `insightTasks.ts`:

```ts
import type { ActiveLLMTask } from './queue';
import type { SseFrame } from './sse';
```

- [ ] **Step 2: Remove the obsolete in-memory pieces from `insightTasks.ts`**

Delete:
- `tasks: Map<string, InsightTask>`
- `getTaskByHash`
- `getTaskById`
- `startTask`
- `abortTask`
- `abortAllInsightTasks`
- `scheduleEviction`
- `InsightTask` interface
- The constants `TERMINAL_RETENTION_MS` (only used by scheduleEviction)

Keep:
- `TEMPS` constant (used by `runInsightWorker`)
- `TaskStatus` type (move to `server/types/db.ts` or inline; insight DB row already has the right values)
- `InsightTaskError` interface (still used by SSE error frame data shape)
- `runInsightWorker` (just added)
- `InsightWorkerParams` (just added)

- [ ] **Step 3: Extend `LLMQueue` in `queue.ts` to dequeue insight tasks**

Replace the `tryStartNext` from Slice 2 with:

```ts
async tryStartNext(): Promise<void> {
  if (this.active) return;
  const db = getDb();
  const next = db
    .prepare(
      `SELECT id, kind, video_sha, created_at FROM (
         SELECT id, 'translate' AS kind, video_sha, created_at,
                priority AS sort_priority
         FROM translate_tasks WHERE status='queued'
         UNION ALL
         SELECT id, 'insight' AS kind, video_sha, created_at,
                0 AS sort_priority
         FROM insight_tasks WHERE status='queued'
       )
       ORDER BY sort_priority DESC, created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string; kind: LLMTaskKind; video_sha: string; created_at: number } | undefined;
  if (!next) return;

  if (next.kind === 'translate') {
    return this.startTranslate(next.id);
  } else {
    return this.startInsight(next.id);
  }
}

private async startTranslate(taskId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, video_sha, target_lang, model
       FROM translate_tasks WHERE id = ?`,
    )
    .get(taskId) as { id: string; video_sha: string; target_lang: string; model: string };
  db.prepare(`UPDATE translate_tasks SET status='running' WHERE id=?`).run(taskId);
  this.active = {
    taskId,
    kind: 'translate',
    videoSha: row.video_sha,
    lang: row.target_lang,
    model: row.model,
    emitter: new EventEmitter(),
    abort: new AbortController(),
    doneCues: [],
    donePromise: Promise.resolve(),
  };
  const wp = this.runTranslateWorker(this.active);
  this.active.donePromise = wp.catch(() => {});
  wp.catch((err) => {
    logEvent({
      level: 'error',
      event: 'llm_worker_crashed',
      kind: 'translate',
      taskId,
      msg: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}

private async startInsight(taskId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, video_sha, model, ui_language
       FROM insight_tasks WHERE id = ?`,
    )
    .get(taskId) as {
      id: string;
      video_sha: string;
      model: string;
      ui_language: 'zh-CN' | 'en';
    };
  // Build prompt: read original.vtt for video, parse cues, build messages
  const origPath = join(SUBCAST_PATHS.cache, row.video_sha, 'original.vtt');
  if (!existsSync(origPath)) {
    db.prepare(
      `UPDATE insight_tasks SET status='error', error_msg=?, completed_at=? WHERE id=?`,
    ).run('ORIGINAL_NOT_READY', Date.now(), taskId);
    // Don't set this.active; just nudge next.
    return this.tryStartNext();
  }
  const transcript = readFileSync(origPath, 'utf-8');
  const cues = parseVtt(transcript);
  const messages = buildInsightMessages(transcript, row.ui_language);

  db.prepare(`UPDATE insight_tasks SET status='running' WHERE id=?`).run(taskId);
  this.active = {
    taskId,
    kind: 'insight',
    videoSha: row.video_sha,
    model: row.model,
    emitter: new EventEmitter(),
    abort: new AbortController(),
    donePromise: Promise.resolve(),
  };
  const params: InsightWorkerParams = {
    videoSha: row.video_sha,
    model: row.model,
    uiLanguage: row.ui_language,
    messages,
    cues,
  };
  const wp = (async () => {
    try {
      await runInsightWorker(this.active!, params);
    } finally {
      this.active!.emitter.emit('end');
      this.active = null;
      this.tryStartNext().catch((err) => {
        logEvent({
          level: 'error',
          event: 'llm_trystartnext_failed',
          msg: err instanceof Error ? err.message : String(err),
        });
      });
    }
  })();
  this.active.donePromise = wp.catch(() => {});
  wp.catch((err) => {
    logEvent({
      level: 'error',
      event: 'llm_worker_crashed',
      kind: 'insight',
      taskId,
      msg: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}
```

Also add the imports at the top of `queue.ts`:

```ts
import { buildInsightMessages } from './insights';
import { runInsightWorker, type InsightWorkerParams } from './insightTasks';
```

- [ ] **Step 4: Extend `LLMQueue.cancel` to dispatch by table**

```ts
cancel(taskId: string): boolean {
  const db = getDb();
  // Try translate first
  const tRow = db
    .prepare(`SELECT status FROM translate_tasks WHERE id=?`)
    .get(taskId) as Pick<TranslateTaskRow, 'status'> | undefined;
  if (tRow) {
    if (tRow.status === 'completed' || tRow.status === 'failed' || tRow.status === 'canceled') {
      return false;
    }
    db.prepare(`UPDATE translate_tasks SET status='canceled' WHERE id=?`).run(taskId);
    if (this.active?.taskId === taskId) this.active.abort.abort();
    logEvent({ level: 'info', event: 'translate_canceled', taskId });
    return true;
  }
  // Then insight
  const iRow = db
    .prepare(`SELECT status FROM insight_tasks WHERE id=?`)
    .get(taskId) as Pick<InsightTaskRow, 'status'> | undefined;
  if (iRow) {
    if (iRow.status === 'done' || iRow.status === 'error' || iRow.status === 'canceled') {
      return false;
    }
    db.prepare(
      `UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`,
    ).run(Date.now(), taskId);
    if (this.active?.taskId === taskId) this.active.abort.abort();
    logEvent({ level: 'info', event: 'insight_canceled', taskId });
    return true;
  }
  return false;
}
```

- [ ] **Step 5: Extend `LLMQueue.attach` to dispatch by kind (DB lookup first)**

Add a helper at the top of `attach`:

```ts
async *attach(taskId: string): AsyncIterable<SseFrame> {
  const db = getDb();
  // Lookup which table the task lives in.
  const tRow = db
    .prepare(`SELECT 1 FROM translate_tasks WHERE id=?`)
    .get(taskId);
  if (tRow) {
    yield* this.attachTranslate(taskId);
    return;
  }
  const iRow = db
    .prepare(`SELECT 1 FROM insight_tasks WHERE id=?`)
    .get(taskId);
  if (iRow) {
    yield* this.attachInsight(taskId);
    return;
  }
  yield {
    event: 'error',
    data: { taskId, code: 'TASK_NOT_FOUND', msg: 'task row missing' },
  };
}
```

`attachTranslate` body = current TranslateQueue.attach logic (already moved in Slice 2).

`attachInsight` body — new:

```ts
private async *attachInsight(taskId: string): AsyncIterable<SseFrame> {
  const db = getDb();
  const task = db
    .prepare(
      `SELECT id, video_sha, status, model, ui_language, error_msg
       FROM insight_tasks WHERE id=?`,
    )
    .get(taskId) as InsightTaskSummary | undefined;
  if (!task) {
    yield {
      event: 'error',
      data: { taskId, code: 'TASK_NOT_FOUND', msg: 'insight task missing' },
    };
    return;
  }

  // Initial start frame (insight protocol)
  yield {
    event: 'start',
    data: {
      taskId,
      model: task.model,
      uiLanguage: task.ui_language,
      status: task.status,
    },
  };

  // Cache hit: read insights.json and emit done
  if (task.status === 'done') {
    const path = join(SUBCAST_PATHS.cache, task.video_sha, 'insights.json');
    if (existsSync(path)) {
      const obj = JSON.parse(readFileSync(path, 'utf-8'));
      yield { event: 'done', data: { insights: obj, fromCache: true } };
      return;
    }
    // File missing → resurrect (Slice 9 enhancement; for now emit error)
    yield {
      event: 'error',
      data: { taskId, code: 'CACHE_MISSING', msg: 'insights.json missing' },
    };
    return;
  }
  if (task.status === 'error') {
    yield {
      event: 'error',
      data: { taskId, code: 'PARSE_FAILED', message: task.error_msg ?? 'previous run failed' },
    };
    return;
  }
  if (task.status === 'canceled') {
    yield { event: 'error', data: { taskId, code: 'CANCELED' } };
    return;
  }

  // queued / running
  yield { event: 'status', data: { taskId, status: task.status } };

  if (!this.active || this.active.taskId !== taskId) {
    await this.tryStartNext();
  }
  if (!this.active || this.active.taskId !== taskId) {
    // Another task is active; client must reconnect after current finishes.
    return;
  }

  const live = this.active;
  const buffer: SseFrame[] = [];
  let resolveNext: (() => void) | null = null;
  let finished = false;
  const onFrame = (f: SseFrame) => {
    buffer.push(f);
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };
  const onEnd = () => {
    finished = true;
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };
  live.emitter.on('frame', onFrame);
  live.emitter.once('end', onEnd);
  try {
    while (true) {
      while (buffer.length > 0) yield buffer.shift()!;
      if (finished) break;
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  } finally {
    live.emitter.off('frame', onFrame);
    live.emitter.off('end', onEnd);
  }
}
```

- [ ] **Step 6: Refactor `server/api/insights.get.ts`**

Replace lines 60-181 (the entire handler) with:

```ts
export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!HASH_RE.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const video = db
    .prepare('SELECT sha256 FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'sha256'> | undefined;
  if (!video) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  const origPath = join(SUBCAST_PATHS.cache, hash, 'original.vtt');
  if (!existsSync(origPath)) {
    throw createError({ statusCode: 409, statusMessage: 'NO_ORIGINAL_VTT' });
  }

  const uiLanguage = pickUiLang(event);
  const model = getModel();

  // Prompt-length guard (existing logic; relocated)
  const transcript = readFileSync(origPath, 'utf-8');
  const messages = buildInsightMessages(transcript, uiLanguage);
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (promptChars > MAX_PROMPT_CHARS) {
    throw createError({ statusCode: 413, statusMessage: 'VIDEO_TOO_LONG' });
  }

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const res = event.node.res;

  const task = llmQueue.ensureInsightTask(hash, uiLanguage, model);
  await llmQueue.tryStartNext();

  let closed = false;
  event.node.req.on('close', () => {
    closed = true;
  });
  for await (const f of llmQueue.attach(task.id)) {
    if (closed || res.writableEnded) break;
    res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
  }
  if (!res.writableEnded) res.end();
});
```

Update imports:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineEventHandler,
  getQuery,
  createError,
  setResponseHeaders,
  getHeader,
} from 'h3';
import type { H3Event } from 'h3';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { llmQueue } from '../utils/queue';
import { buildInsightMessages } from '../utils/insights';
import { HASH_RE } from '../utils/validate';
import type { SettingsRow, VideoRow } from '../types/db';
```

- [ ] **Step 7: Add cross-kind FIFO test in `server/utils/__tests__/llm-queue.test.ts`**

```ts
import { translateQueue } from '../queue';

describe('llmQueue cross-kind FIFO', () => {
  it('dequeues by created_at across translate and insight tables', async () => {
    const t1 = translateQueue.ensureTask(HASH_A, 'zh-CN');
    // Insert insight with later created_at; ensure FIFO
    await new Promise((r) => setTimeout(r, 5));
    const i1 = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
    // Inspect dequeue order without actually starting workers (read-only)
    const db = getDb();
    const next = db
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
```

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run server/utils/__tests__/llm-queue.test.ts server/utils/__tests__/queue.test.ts`
Expected: all pass.

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 9: Manual sanity**

- `pnpm dev`
- Open a video, click the AI Insights tab → click "Generate"
- Verify: SSE streams tokens; on completion `insights.json` written; `insight_tasks` row status='done'
- Refresh page → reopen the tab → cached result loads (no re-run)
- Open two different videos in separate windows, trigger insight on both → second one queues (status='queued') and starts only after first completes

- [ ] **Step 10: Commit**

```bash
git add server/utils/queue.ts server/utils/insightTasks.ts server/api/insights.get.ts server/utils/__tests__/llm-queue.test.ts
git commit -m "feat(queue): move insight worker into LLMQueue; remove in-memory tasks map"
```

---

## Slice 4: Cancel endpoints — new `/api/queue/insight/[id]` + proxy old `/api/insights/[id]`

**Files:**
- Create: `server/api/queue/insight/[id].delete.ts`
- Modify: `server/api/insights/[id].delete.ts`

- [ ] **Step 1: Create new endpoint**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { llmQueue } from '../../../utils/queue';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'MISSING_ID' });
  const ok = llmQueue.cancel(id);
  if (!ok) {
    throw createError({
      statusCode: 404,
      statusMessage: 'TASK_NOT_FOUND_OR_TERMINAL',
    });
  }
  return { ok: true, taskId: id };
});
```

- [ ] **Step 2: Replace `server/api/insights/[id].delete.ts` body**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { llmQueue } from '../../utils/queue';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_ID' });
  const aborted = llmQueue.cancel(id);
  return { ok: true, aborted };
});
```

- [ ] **Step 3: Manual verification**

- Start `pnpm dev`
- Trigger an insight task; while running, `curl -X DELETE http://localhost:3000/api/queue/insight/<task-id>`
- Verify: SSE emits `{event: 'error', data: {code: 'CANCELED'}}`, DB row status='canceled', queue dequeues next task

- [ ] **Step 4: Commit**

```bash
git add server/api/queue/insight/\[id\].delete.ts server/api/insights/\[id\].delete.ts
git commit -m "feat(api): unify insight cancel via /api/queue/insight/:id; legacy endpoint proxies"
```

---

## Slice 5: `/api/queue/list` integration

**Files:**
- Modify: `server/api/queue/list.get.ts`

- [ ] **Step 1: Add insight rows to the response**

Replace `server/api/queue/list.get.ts` with:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { getDb } from '../../utils/db';
import type {
  InsightTaskRow,
  TranscribeTaskRow,
  TranslateTaskRow,
} from '../../types/db';

type VideoJoinFields = {
  original_name: string | null;
  display_name: string | null;
};

type TranscribeJoinRow =
  & Pick<TranscribeTaskRow, 'id' | 'video_sha' | 'status' | 'model' | 'total_chunks' | 'done_chunks' | 'created_at' | 'error_msg'>
  & VideoJoinFields;

type TranslateJoinRow =
  & Pick<TranslateTaskRow, 'id' | 'video_sha' | 'target_lang' | 'status' | 'model' | 'progress_pct' | 'priority' | 'created_at' | 'error_msg'>
  & VideoJoinFields;

type InsightJoinRow =
  & Pick<InsightTaskRow, 'id' | 'video_sha' | 'status' | 'model' | 'ui_language' | 'created_at' | 'error_msg'>
  & VideoJoinFields;

interface QueueItem {
  kind: 'transcribe' | 'translate' | 'insight';
  id: string;
  videoSha: string;
  videoName: string;
  status: string;
  model: string;
  progressPct: number;
  totalChunks?: number | null;
  doneChunks?: number;
  targetLang?: string;
  uiLanguage?: 'zh-CN' | 'en';
  createdAt: number;
  errorMsg?: string | null;
}

export default defineEventHandler(() => {
  const db = getDb();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  const transcribes = db
    .prepare(
      `SELECT t.id, t.video_sha, t.status, t.model, t.total_chunks, t.done_chunks,
              t.created_at, t.error_msg, v.original_name, v.display_name
       FROM transcribe_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.created_at DESC`,
    )
    .all(cutoff) as TranscribeJoinRow[];

  const translates = db
    .prepare(
      `SELECT t.id, t.video_sha, t.target_lang, t.status, t.model, t.progress_pct,
              t.priority, t.created_at, t.error_msg, v.original_name, v.display_name
       FROM translate_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.priority DESC, t.created_at DESC`,
    )
    .all(cutoff) as TranslateJoinRow[];

  const insights = db
    .prepare(
      `SELECT t.id, t.video_sha, t.status, t.model, t.ui_language, t.created_at,
              t.error_msg, v.original_name, v.display_name
       FROM insight_tasks t
       LEFT JOIN videos v ON v.sha256 = t.video_sha
       WHERE t.status IN ('queued','running') OR t.created_at > ?
       ORDER BY t.created_at DESC`,
    )
    .all(cutoff) as InsightJoinRow[];

  const items: QueueItem[] = [];
  for (const t of transcribes) {
    const pct = t.total_chunks
      ? Math.round((t.done_chunks / t.total_chunks) * 100)
      : 0;
    items.push({
      kind: 'transcribe',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      model: t.model,
      progressPct: pct,
      totalChunks: t.total_chunks,
      doneChunks: t.done_chunks,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
    });
  }
  for (const t of translates) {
    items.push({
      kind: 'translate',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      model: t.model,
      progressPct: t.progress_pct,
      targetLang: t.target_lang,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
    });
  }
  for (const t of insights) {
    items.push({
      kind: 'insight',
      id: t.id,
      videoSha: t.video_sha,
      videoName: t.display_name ?? t.original_name ?? t.video_sha.slice(0, 12),
      status: t.status,
      model: t.model,
      progressPct: t.status === 'done' ? 100 : 0,
      uiLanguage: t.ui_language,
      createdAt: t.created_at,
      errorMsg: t.error_msg,
    });
  }
  const order = (s: string) =>
    s === 'running' ? 0 : s === 'queued' ? 1 : 2;
  items.sort((a, b) => {
    const oa = order(a.status), ob = order(b.status);
    if (oa !== ob) return oa - ob;
    return b.createdAt - a.createdAt;
  });
  return { items };
});
```

- [ ] **Step 2: Manual verification**

- `curl http://localhost:3000/api/queue/list | jq '.items[] | select(.kind=="insight")'`
- Trigger an insight; verify it appears in the response with kind='insight', status='running', uiLanguage set

- [ ] **Step 3: Commit**

```bash
git add server/api/queue/list.get.ts
git commit -m "feat(api): include insight tasks in /api/queue/list"
```

---

## Slice 6: Plugin / lifecycle wiring

**Files:**
- Modify: `server/plugins/00.queue.ts`
- Modify: `server/plugins/02.recover-zombie-tasks.ts`
- Modify: `server/api/desktop/shutdown.post.ts`

- [ ] **Step 1: `server/plugins/00.queue.ts`**

Replace the file with:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
// Restart recovery for transcribe + LLM queues. Transcription has chunk-level
// resume — interrupted runs continue from the last completed chunk, so
// demoting 'running' back to 'queued' is safe and the desired UX.
//
// Translate + Insight recovery lives in 02.recover-zombie-tasks.ts: in
// desktop mode we mark them 'failed'/'error' so the user can decide to
// retry rather than silently re-spending tokens (§6.10, decision 21).
// Web mode keeps the silent-restart behavior there.
import { getDb } from '../utils/db';
import { transcribeQueue, llmQueue } from '../utils/queue';

export default defineNitroPlugin(async () => {
  const db = getDb();
  db.prepare(`UPDATE transcribe_tasks SET status='queued' WHERE status='running'`).run();
  await transcribeQueue.tryStartNext();
  // llmQueue is started after 02.recover-zombie-tasks has had a chance to
  // (web) re-queue or (desktop) fail-mark surviving translate + insight rows.
  await llmQueue.tryStartNext();
});
```

- [ ] **Step 2: `server/plugins/02.recover-zombie-tasks.ts`**

Change the last line from `await translateQueue.tryStartNext();` to `await llmQueue.tryStartNext();`. Update the import:

```ts
import { llmQueue } from '../utils/queue';
```

(Remove `import { translateQueue } ...`.)

- [ ] **Step 3: `server/api/desktop/shutdown.post.ts`**

Replace the file with:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * POST /api/desktop/shutdown
 *
 * Proactive cleanup right before Electron exits. Called once from
 * `app.on('before-quit')` after `event.preventDefault()`. Cancels the
 * one in-flight transcribe + the one in-flight LLM task (translate or
 * insight), then tears down llama-server.
 *
 * Idempotent. 404 in web mode.
 */

import { createError, defineEventHandler } from 'h3';
import { transcribeQueue, llmQueue } from '../../utils/queue';
import { getLlmServer } from '../../utils/llmServer';

export default defineEventHandler(async () => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  await Promise.all([transcribeQueue.cancelActive(), llmQueue.cancelActive()]);
  try {
    await getLlmServer().stop();
  } catch (err) {
    console.warn('[shutdown] llm server stop failed:', err);
  }
  return { ok: true };
});
```

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 5: Manual sanity (desktop mode)**

- `pnpm desktop` (or whatever launches Electron)
- Trigger an insight task; while running, quit the app
- Re-launch; verify: `insight_tasks` row status='error' with `error_msg='Interrupted by app exit'`; UI surfaces the error

- [ ] **Step 6: Commit**

```bash
git add server/plugins/00.queue.ts server/plugins/02.recover-zombie-tasks.ts server/api/desktop/shutdown.post.ts
git commit -m "refactor(lifecycle): switch boot/shutdown wiring to llmQueue"
```

---

## Slice 7: External callers (`getTaskByHash` removals)

**Files:**
- Modify: `server/api/transcribe/retry.post.ts`
- Modify: `server/api/cache/list.get.ts`
- Modify: `server/api/cache/[hash].delete.ts`

- [ ] **Step 1: `server/api/transcribe/retry.post.ts`**

Replace lines 31-32 (import) and lines 73-75 (use):

```ts
// Top: replace the insightTasks import
import { llmQueue } from '../../utils/queue';
```

Replace the `getTaskByHash + abortTask` block:

```ts
const runningInsights = db
  .prepare(
    `SELECT id FROM insight_tasks
     WHERE video_sha = ? AND status IN ('queued','running')`,
  )
  .all(hash) as { id: string }[];
for (const row of runningInsights) {
  llmQueue.cancel(row.id);
}
```

- [ ] **Step 2: `server/api/cache/list.get.ts`**

Replace the import:

```ts
// Remove: import { getTaskByHash } from '../../utils/insightTasks';
```

Replace line 70 (the `hasRunningInsight` computation). The endpoint loops over rows and queries per-video. Replace with a single batched query before the loop, or per-row EXISTS:

```ts
// Per-row EXISTS variant (simpler):
const hasRunningInsightStmt = db.prepare(
  `SELECT EXISTS(
     SELECT 1 FROM insight_tasks WHERE video_sha = ? AND status IN ('queued','running')
   ) AS has_running`,
);
// ... inside the loop:
const hasRunningInsight = (
  hasRunningInsightStmt.get(r.sha256) as { has_running: number }
).has_running === 1;
```

- [ ] **Step 3: `server/api/cache/[hash].delete.ts`**

Replace the import:

```ts
// Remove: import { getTaskByHash, abortTask } from '../../utils/insightTasks';
import { llmQueue } from '../../utils/queue';
```

Replace lines 25-26:

```ts
const runningInsights = db
  .prepare(
    `SELECT id FROM insight_tasks
     WHERE video_sha = ? AND status IN ('queued','running')`,
  )
  .all(hash) as { id: string }[];
for (const row of runningInsights) {
  llmQueue.cancel(row.id);
}
```

- [ ] **Step 4: Run tests + manual sanity**

Run: `pnpm test`
Expected: all pass.

- Manual: Trigger insight on video A; while running, hit `DELETE /api/cache/<hashA>`; verify insight gets canceled and cache directory cleared.

- [ ] **Step 5: Commit**

```bash
git add server/api/transcribe/retry.post.ts server/api/cache/list.get.ts server/api/cache/\[hash\].delete.ts
git commit -m "refactor(api): drop in-memory getTaskByHash; query insight_tasks directly"
```

---

## Slice 8: Frontend — tasks panel insight rendering

**Files:**
- Modify: `app/pages/index.vue`

- [ ] **Step 1: Find the tasks panel block (around lines 492-557 per spec) and add insight branch**

In the template:

```vue
<!-- After existing translate branch -->
<span v-else-if="item.kind === 'insight'">
  {{ item.uiLanguage === 'zh-CN' ? $t('queue.insight.zh') : $t('queue.insight.en') }} · {{ item.model }}
</span>
```

(If no i18n keys exist for these labels, hardcode `'AI 总结 (中)'` / `'AI Summary (en)'` for now and add an i18n TODO note.)

- [ ] **Step 2: Add the insight cancel branch in `onCancel(item)`**

Find the existing function (likely near the translate cancel):

```ts
async function onCancel(item: QueueItem) {
  if (item.kind === 'transcribe') {
    await $fetch(`/api/queue/transcribe/${item.id}`, { method: 'DELETE' });
  } else if (item.kind === 'translate') {
    await $fetch(`/api/queue/translate/${item.id}`, { method: 'DELETE' });
  } else if (item.kind === 'insight') {
    await $fetch(`/api/queue/insight/${item.id}`, { method: 'DELETE' });
  }
  await refreshQueue();
}
```

- [ ] **Step 3: Update QueueItem type if locally declared in the page**

Add `'insight'` to the `kind` union and add optional `uiLanguage?: 'zh-CN' | 'en'`. (If the type comes from a shared module, update there.)

- [ ] **Step 4: Manual sanity**

- `pnpm dev`
- Trigger an insight; verify it appears in the tasks panel with the expected label
- Click the cancel button while running; verify it cancels (DB row → 'canceled', SSE emits CANCELED)

- [ ] **Step 5: Commit**

```bash
git add app/pages/index.vue
git commit -m "feat(ui): render insight tasks in home tasks panel + cancel handler"
```

---

## Slice 9: File-missing self-heal in `LLMQueue.attach`

This slice fixes the pre-existing bug in `TranslateQueue.attach` (now `LLMQueue.attachTranslate`) where status='completed' but VTT file gone hangs the SSE, AND extends the same fix to `attachInsight` which currently emits `CACHE_MISSING` (placeholder from Slice 3).

**Files:**
- Modify: `server/utils/queue.ts`
- Modify: `server/utils/__tests__/llm-queue.test.ts`

- [ ] **Step 1: In `LLMQueue.attachTranslate`, replace the cache-hit short-circuit block**

Existing code (around the `task.status === 'completed' && existsSync(vttPath)` branch):

```ts
// Cache hit short-circuit
const vttPath = join(SUBCAST_PATHS.cache, task.video_sha, `${task.target_lang}.vtt`);
if (task.status === 'completed') {
  if (existsSync(vttPath)) {
    const cues = parseVtt(await readFile(vttPath, 'utf8'));
    yield {
      event: 'status',
      data: {
        taskId,
        status: 'running',
        model: task.model,
        lang: task.target_lang,
        fromCache: true,
      },
    };
    yield {
      event: 'cue-translated',
      data: {
        taskId,
        batchIdx: 0,
        cues: cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
      },
    };
    yield { event: 'done', data: { taskId, totalCues: cues.length, fromCache: true } };
    return;
  }
  // File missing — self-heal: demote back to queued and re-run.
  logEvent({
    level: 'warn',
    event: 'result_file_missing_resurrect',
    kind: 'translate',
    taskId,
    expectedPath: vttPath,
  });
  getDb()
    .prepare(
      `UPDATE translate_tasks SET status='queued', progress_pct=0, error_msg=NULL WHERE id=?`,
    )
    .run(taskId);
  yield { event: 'status', data: { taskId, status: 'queued' } };
  await this.tryStartNext();
  // Fall through to live-tail below
}
```

- [ ] **Step 2: In `LLMQueue.attachInsight`, replace the `task.status === 'done'` block**

```ts
if (task.status === 'done') {
  const path = join(SUBCAST_PATHS.cache, task.video_sha, 'insights.json');
  if (existsSync(path)) {
    const obj = JSON.parse(readFileSync(path, 'utf-8'));
    yield { event: 'done', data: { insights: obj, fromCache: true } };
    return;
  }
  // File missing — self-heal: demote back to queued and re-run.
  logEvent({
    level: 'warn',
    event: 'result_file_missing_resurrect',
    kind: 'insight',
    taskId,
    expectedPath: path,
  });
  getDb()
    .prepare(`UPDATE insight_tasks SET status='queued', error_msg=NULL WHERE id=?`)
    .run(taskId);
  yield { event: 'status', data: { taskId, status: 'queued' } };
  await this.tryStartNext();
  // Fall through to live-tail (re-fetch task, continue normally)
  task.status = 'queued';
}
```

- [ ] **Step 3: Add tests for both kinds**

Append to `server/utils/__tests__/llm-queue.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync, rmSync as rmFile } from 'node:fs';
import { SUBCAST_PATHS } from '../db';

describe('LLMQueue.attach self-heal on missing result file', () => {
  it('insight: done row + missing insights.json → demoted to queued', async () => {
    const t = llmQueue.ensureInsightTask(HASH_A, 'zh-CN', 'qwen2.5:7b');
    getDb()
      .prepare(`UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`)
      .run(Date.now(), t.id);
    // Note: insights.json deliberately not written
    const frames: Array<{ event: string; data: any }> = [];
    for await (const f of llmQueue.attach(t.id)) {
      frames.push(f);
      if (frames.length >= 3) break; // start, status:queued, then live-tail
    }
    const queuedFrame = frames.find((f) => f.event === 'status' && f.data.status === 'queued');
    expect(queuedFrame).toBeDefined();
    const row = getDb()
      .prepare(`SELECT status FROM insight_tasks WHERE id=?`)
      .get(t.id) as { status: string };
    expect(row.status).toMatch(/queued|running/);
  });

  it('translate: completed row + missing {lang}.vtt → demoted to queued', async () => {
    const t = translateQueue.ensureTask(HASH_A, 'zh-CN');
    getDb()
      .prepare(`UPDATE translate_tasks SET status='completed', completed_at=? WHERE id=?`)
      .run(Date.now(), t.id);
    const frames: Array<{ event: string; data: any }> = [];
    for await (const f of llmQueue.attach(t.id)) {
      frames.push(f);
      if (frames.length >= 3) break;
    }
    const queuedFrame = frames.find((f) => f.event === 'status' && f.data.status === 'queued');
    expect(queuedFrame).toBeDefined();
    const row = getDb()
      .prepare(`SELECT status FROM translate_tasks WHERE id=?`)
      .get(t.id) as { status: string };
    expect(row.status).toMatch(/queued|running/);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run server/utils/__tests__/llm-queue.test.ts`
Expected: 2 new tests pass; full file green.

Run: `pnpm test`
Expected: all pass.

- [ ] **Step 5: Manual verification**

- Trigger insight on a video; let it complete (cache file written)
- `rm ~/.subcast/cache/<hash>/insights.json` (file present, row says done)
- Click "Generate" again in UI → should kick off a new run instead of hanging
- Repeat for translate: trigger translate, complete, `rm ~/.subcast/cache/<hash>/<lang>.vtt`, re-attach via player → should re-run

- [ ] **Step 6: Commit**

```bash
git add server/utils/queue.ts server/utils/__tests__/llm-queue.test.ts
git commit -m "fix(queue): self-heal missing result file by demoting row to queued"
```

---

## Self-Review Checklist

Before handing off to execution, the plan author runs:

**1. Spec coverage** — every spec section maps to a slice:

| Spec section | Slice |
|---|---|
| §2 Architecture (LLMQueue + cross-table FIFO) | Slice 1, 2, 3 |
| §3 API & SSE (`/api/insights`, queue list, cancel) | Slice 3, 4, 5 |
| §4 Data model (`ensureInsightTask`, dedup, persistence) | Slice 1, 3 |
| §5 Error handling (worker crash, llama-server down, starvation) | Slice 3 (worker), pre-existing patterns |
| §5 File-missing self-heal | Slice 9 |
| §6 Recovery + Electron quit | Slice 6 |
| §7 Frontend tasks panel | Slice 8 |
| §8 Non-goals (priority, abortAll, etc.) | Honored throughout |
| §9 Verification list | Distributed across slice manual-verification steps |

**2. Placeholder scan** — none.

**3. Type consistency** — `LLMTaskKind`, `ActiveLLMTask`, `InsightTaskSummary`, `InsightWorkerParams` defined in Slice 1/3 and used consistently downstream. `QueueItem.kind` union extended to 3 values in Slice 5 and consumed in Slice 8.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-llm-queue-insight-integration.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per slice, review between slices, fast iteration
2. **Inline Execution** — Execute slices in this session using executing-plans, batch execution with checkpoints

Which approach?
