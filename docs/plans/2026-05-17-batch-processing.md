# Batch Processing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a free batch-processing workflow that lets users import multiple media files and run transcription, translation, AI insights, and diarization without repeated manual clicks.

**Architecture:** Add a thin batch orchestration layer above the existing upload, transcribe, LLM, and diarization task systems. Do not create a second transcription or LLM executor; batch jobs should enqueue existing task types and track per-file/per-step progress in new batch tables.

**Tech Stack:** Nuxt 4, Vue 3, Nitro server routes, better-sqlite3, existing `transcribeQueue`, `llmQueue` / `translateQueue`, diarization pipeline, Electron file picking/export helpers.

---

## Product Scope

### MVP

- User selects multiple files from the upload entry point.
- Selecting one file keeps the current single-file flow.
- Selecting multiple files opens a batch-processing confirmation dialog.
- User chooses one workflow preset:
  - Transcribe only.
  - Transcribe + translate.
  - Transcribe + translate + AI insights.
  - Transcribe + translate + AI insights + diarization.
- User can fine-tune:
  - Whisper model.
  - Target translation languages.
  - Whether to generate AI insights.
  - Whether to run speaker diarization.
- App creates one batch job with per-video items.
- Batch job runs one file through the full selected workflow before starting the next file:
  - Ensure video exists in library.
  - Ensure original transcript.
  - Ensure selected translations.
  - Ensure AI insights.
  - Ensure diarization.
- UI shows batch-level and per-item progress.
- Failed items do not stop the whole batch.
- User can cancel a whole batch or retry failed items.
- MVP does not auto-export files after completion. Results are cached in the library and can be opened/exported from the existing single-file views.

### Explicit Non-Goals For MVP

- No cloud execution.
- No parallel transcribe workers beyond current queue behavior.
- No custom workflow graph builder.
- No automatic scheduled folders.
- No team features.
- No license/payment enforcement.
- No automatic export/output directory selection in MVP.

---

## Current System Facts To Reuse

- Upload route: `server/api/upload.post.ts`
  - Writes media into `SUBCAST_PATHS.videos`.
  - Creates or restores a `videos` row.
  - Optional subtitle upload already marks `original.vtt` and completed transcribe rows.
- Transcribe queue: `server/utils/queue.ts`
  - `transcribeQueue.ensureTask(videoSha, model?)`
  - `transcribeQueue.tryStartNext()`
  - Writes `cache/<hash>/original.vtt` only after all chunks complete.
- Translate queue:
  - `translateQueue.ensureTask(videoSha, lang, model?)`
  - `translateQueue.bumpPriority(task.id)`
  - `translateQueue.tryStartNext()`
  - Requires `original.vtt`.
- Insight queue:
  - `llmQueue.ensureInsightTask(videoSha, uiLanguage, model)`
  - `llmQueue.tryStartNext()`
  - Requires `original.vtt`.
- Diarization:
  - `server/api/diarize/[hash]/run.post.ts` currently wraps task creation and `runDiarize`.
  - `server/utils/diarize/readiness.ts` ensures completed transcribe chunks.
  - For batch orchestration, extract a reusable `ensureDiarizeTask(videoSha, topK?)` helper instead of calling HTTP from server code.
- Queue list UI:
  - `server/api/queue/list.get.ts`
  - `app/composables/useQueueList.ts`
  - Can be reused or extended for global progress, but batch UI needs its own grouped view.
- Upload UI should be enhanced for multi-file selection first. Library multi-select can be a follow-up, not MVP.

---

## Data Model

Add migrations after current `user_version = 11`.

### Tables

```sql
CREATE TABLE IF NOT EXISTS batch_jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL, -- queued | running | completed | failed | canceled
  preset          TEXT NOT NULL,
  options_json    TEXT NOT NULL,
  total_items     INTEGER NOT NULL DEFAULT 0,
  done_items      INTEGER NOT NULL DEFAULT 0,
  failed_items    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  error_msg       TEXT
);

CREATE TABLE IF NOT EXISTS batch_items (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
  video_sha       TEXT NOT NULL REFERENCES videos(sha256),
  status          TEXT NOT NULL, -- queued | running | completed | failed | canceled
  current_step    TEXT,
  step_status_json TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  error_msg       TEXT,
  UNIQUE(batch_id, video_sha)
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id, status, created_at);
```

### Step Status JSON

```ts
interface BatchStepStatus {
  transcribe?: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  translate?: Record<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'>;
  insights?: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  diarize?: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
}
```

Keep JSON because the workflow shape is small and product-driven. Do not over-normalize each step until history/analytics needs it.

---

## Task 1: Add Batch Schema And Types

**Files:**
- Modify: `server/utils/db.ts`
- Create: `server/types/batch.ts`
- Test: `server/utils/__tests__/batch-schema.test.ts`

**Step 1: Write the failing schema test**

Create `server/utils/__tests__/batch-schema.test.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { describe, expect, it } from 'vitest';
import { getDb } from '../db';

describe('batch schema', () => {
  it('creates batch job and item tables', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('batch_jobs', 'batch_items')")
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name).sort()).toEqual(['batch_items', 'batch_jobs']);
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test:run server/utils/__tests__/batch-schema.test.ts
```

Expected: fail because tables do not exist.

**Step 3: Add migration**

In `server/utils/db.ts`, add `if (version < 12)` with the SQL from the Data Model section.

**Step 4: Add shared server-side types**

Create `server/types/batch.ts`:

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
export type BatchJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type BatchItemStatus = BatchJobStatus;
export type BatchStep = 'transcribe' | 'translate' | 'insights' | 'diarize';
export type BatchStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface BatchOptions {
  whisperModel: string;
  targetLangs: string[];
  insights: boolean;
  diarize: boolean;
  diarizeTopK?: number;
}

export interface BatchStepStatus {
  transcribe?: BatchStepState;
  translate?: Record<string, BatchStepState>;
  insights?: BatchStepState;
  diarize?: BatchStepState;
}
```

**Step 5: Run test**

Run:

```bash
pnpm test:run server/utils/__tests__/batch-schema.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add server/utils/db.ts server/types/batch.ts server/utils/__tests__/batch-schema.test.ts
git commit -m "feat: add batch processing schema"
```

---

## Task 2: Build Batch Repository Helpers

**Files:**
- Create: `server/utils/batchRepo.ts`
- Test: `server/utils/__tests__/batch-repo.test.ts`

**Step 1: Write failing tests**

Test:

- Create a batch with two videos.
- Verify job counts.
- Mark one item completed.
- Mark one item failed.
- Verify aggregate job counts update.
- Cancel a queued batch.

**Step 2: Implement repository**

Create helpers:

```ts
createBatchJob(input: {
  name: string;
  preset: string;
  options: BatchOptions;
  videoShas: string[];
}): { id: string };

listBatchJobs(): BatchJobSummary[];
getBatchJob(id: string): BatchJobDetail | null;
markItemStep(batchItemId: string, step: BatchStep, state: BatchStepState, lang?: string): void;
markItemStatus(batchItemId: string, status: BatchItemStatus, errorMsg?: string): void;
recomputeBatchStatus(batchId: string): void;
cancelBatch(batchId: string): void;
```

Use transactions for status updates.

**Step 3: Run tests**

Run:

```bash
pnpm test:run server/utils/__tests__/batch-repo.test.ts
```

Expected: pass.

**Step 4: Commit**

```bash
git add server/utils/batchRepo.ts server/utils/__tests__/batch-repo.test.ts
git commit -m "feat: add batch repository helpers"
```

---

## Task 3: Extract Reusable Diarize Enqueue Helper

**Files:**
- Create: `server/utils/diarize/tasks.ts`
- Modify: `server/api/diarize/[hash]/run.post.ts`
- Test: `server/utils/diarize/__tests__/tasks.test.ts`

**Step 1: Write failing tests**

Cover:

- Throws `TRANSCRIBE_NOT_DONE` when readiness fails.
- Returns existing running task instead of creating duplicate.
- Reuses failed/done row by setting status to running.

**Step 2: Extract helper**

Create:

```ts
export function ensureDiarizeTask(videoSha: string, opts?: { topK?: number }): {
  taskId: string;
  status: 'running';
  alreadyRunning: boolean;
}
```

The helper should contain the DB logic currently in `server/api/diarize/[hash]/run.post.ts`.

**Step 3: Update API route**

`run.post.ts` should:

- Validate hash/body.
- Call `ensureDiarizeTask`.
- If not already running, fire `runDiarize`.
- Return `{ ok: true, taskId, status: 'running' }`.

**Step 4: Run tests**

Run:

```bash
pnpm test:run server/utils/diarize/__tests__/tasks.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add server/utils/diarize/tasks.ts server/api/diarize/[hash]/run.post.ts server/utils/diarize/__tests__/tasks.test.ts
git commit -m "refactor: extract diarize task enqueue helper"
```

---

## Task 4: Add Batch Orchestrator

**Files:**
- Create: `server/utils/batchRunner.ts`
- Test: `server/utils/__tests__/batch-runner.test.ts`

**Architecture:**

The orchestrator should not process audio/text itself. It should enqueue existing tasks and poll DB/task state between steps.

**Step 1: Write failing tests**

Use mocks or lightweight DB state to verify:

- A batch item with no `original.vtt` enqueues transcribe first.
- A batch item with `original.vtt` skips transcribe.
- Translation waits until original transcript exists.
- Insight waits until original transcript exists.
- Failed translate marks only that language failed and continues next item.

**Step 2: Implement runner skeleton**

Create:

```ts
export async function startBatch(batchId: string): Promise<void>;
export async function runBatchOnce(batchId: string): Promise<void>;
```

`startBatch` should guard against duplicate in-memory runners:

```ts
const activeBatches = new Set<string>();
```

**Step 3: Implement per-item workflow**

Pseudo-flow:

```ts
for each queued/running item:
  mark item running
  if canceled: stop
  ensureTranscribeDone()
  for lang of targetLangs: ensureTranslateDone(lang)
  if insights: ensureInsightsDone()
  if diarize: ensureDiarizeDone()
  mark item completed
recompute batch
```

Each `ensureXDone` should:

- Skip if artifact/task already done.
- Enqueue existing queue task if needed.
- Trigger queue `tryStartNext()`.
- Wait/poll DB with a small interval.
- Respect batch canceled status.

**Step 4: Keep polling simple**

Use a conservative interval:

```ts
const POLL_MS = 1000;
```

This is acceptable for desktop local jobs and avoids adding event-coupling into existing queues.

**Step 5: Run tests**

Run:

```bash
pnpm test:run server/utils/__tests__/batch-runner.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add server/utils/batchRunner.ts server/utils/__tests__/batch-runner.test.ts
git commit -m "feat: add batch processing runner"
```

---

## Task 5: Add Batch API Routes

**Files:**
- Create: `server/api/batches/index.post.ts`
- Create: `server/api/batches/index.get.ts`
- Create: `server/api/batches/[id].get.ts`
- Create: `server/api/batches/[id]/cancel.post.ts`
- Create: `server/api/batches/[id]/retry.post.ts`
- Test: `server/utils/__tests__/batch-api.test.ts`

**Step 1: API contract**

`POST /api/batches`

```ts
{
  name: string;
  preset: string;
  videoShas: string[];
  options: BatchOptions;
}
```

Response:

```ts
{ id: string }
```

`GET /api/batches`

```ts
{ items: BatchJobSummary[] }
```

`GET /api/batches/:id`

```ts
{ job: BatchJobDetail }
```

`POST /api/batches/:id/cancel`

```ts
{ ok: true }
```

`POST /api/batches/:id/retry`

```ts
{ ok: true }
```

**Step 2: Validation**

- `videoShas` must be non-empty.
- Every hash must exist in `videos`.
- `targetLangs` must use the existing translate language regex.
- `name` length max 120.
- `preset` must be one of known presets.

**Step 3: Start runner after create/retry**

After creating a batch:

```ts
void startBatch(id).catch(...)
```

Log runner startup errors using `logEvent`.

**Step 4: Run tests**

Run:

```bash
pnpm test:run server/utils/__tests__/batch-api.test.ts
```

Expected: pass.

**Step 5: Commit**

```bash
git add server/api/batches server/utils/__tests__/batch-api.test.ts
git commit -m "feat: add batch processing API"
```

---

## Task 6: Add Multi-File Upload Batch Entry Point

**Files:**
- Modify: upload entry page/component
- Create: `app/components/BatchCreateDialog.vue`
- Modify: `i18n/locales/zh-CN.json`
- Modify: `i18n/locales/en.json`

**Step 1: UI behavior**

In the upload entry:

- Allow selecting multiple media files.
- If one media file is selected, keep the current upload behavior.
- If multiple media files are selected, open `BatchCreateDialog`.
- Upload each selected file through existing `/api/upload` before creating the batch job.
- If any upload fails, show per-file upload errors and allow retrying upload.

**Step 2: BatchCreateDialog controls**

Dialog should include:

- Preset segmented control:
  - Transcribe only.
  - Transcribe + translate.
  - Transcribe + AI insights.
  - Transcribe + translate + AI insights.
  - Full processing.
- Whisper model select.
- Target language multi-select.
- Toggle AI insights.
- Toggle speaker identification.
- Start button.

Keep the layout dense and operational, not marketing-style.

**Step 3: Submit**

Dialog calls:

```ts
await $fetch('/api/batches', {
  method: 'POST',
  body: {
    name,
    preset,
    videoShas,
    options,
  },
});
```

Then navigate to the batch detail page.

**Step 4: Manual verification**

Run:

```bash
pnpm dev
```

Open upload entry, select two videos, upload them, confirm batch route request payload.

**Step 5: Commit**

```bash
git add app/components/BatchCreateDialog.vue i18n/locales/zh-CN.json i18n/locales/en.json
git commit -m "feat: add multi-file batch creation UI"
```

---

## Task 7: Add Batch Monitor UI

**Files:**
- Create: `app/pages/batches.vue`
- Create: `app/pages/batches/[id].vue`
- Create: `app/composables/useBatchList.ts`
- Create: `app/composables/useBatchDetail.ts`
- Modify: `app/components/AppHeader.vue` or existing navigation owner
- Modify: `i18n/locales/zh-CN.json`
- Modify: `i18n/locales/en.json`

**Step 1: Batch list page**

Show:

- Job name.
- Status.
- Done / total.
- Failed count.
- Created time.
- Actions: open, cancel, retry failed.

**Step 2: Batch detail page**

Show:

- Per-item video name.
- Current step.
- Step status chips: transcribe, translate languages, insights, diarize.
- Error message.
- Actions: open player, retry failed item if supported later.

**Step 3: Polling**

Use polling every 2 seconds while any job is queued/running.

**Step 4: Manual verification**

Create a batch and watch it move through states.

**Step 5: Commit**

```bash
git add app/pages/batches.vue app/pages/batches/[id].vue app/composables/useBatchList.ts app/composables/useBatchDetail.ts app/components/AppHeader.vue i18n/locales/zh-CN.json i18n/locales/en.json
git commit -m "feat: add batch monitor UI"
```

---

## Task 8: Full Verification

**Files:**
- Modify docs if needed:
  - `docs/smoke-tests.md`
  - `docs/release-runbook.md`

**Step 1: Run focused tests**

```bash
pnpm test:run server/utils/__tests__/batch-schema.test.ts
pnpm test:run server/utils/__tests__/batch-repo.test.ts
pnpm test:run server/utils/__tests__/batch-runner.test.ts
pnpm test:run server/utils/__tests__/batch-api.test.ts
```

Expected: all pass.

**Step 2: Run broad checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Expected: all pass. The existing Vue/Volar `vue-router/volar/sfc-route-blocks` warning may appear during typecheck but should exit 0.

**Step 3: Desktop smoke**

```bash
pnpm dev:desktop
```

Manual:

- Upload 2 videos.
- Create batch: transcribe only.
- Create batch: transcribe + translate.
- Cancel a running batch.
- Retry failed batch.
- Confirm queue panel and batch monitor agree.

**Step 4: Commit final docs**

```bash
git add docs/smoke-tests.md docs/release-runbook.md
git commit -m "docs: add batch processing smoke tests"
```

---

## Risk Review

- **Double execution risk:** Batch runner must use existing unique task constraints and `ensureTask` helpers. Never insert task rows directly except batch tables.
- **State drift risk:** Existing task may fail while batch item still says running. Runner polling must map task failure into batch item failure.
- **Cancellation risk:** Canceling batch should cancel queued/running child tasks where possible, but completed artifacts should remain.
- **Diarization risk:** Current diarize API has fire-and-forget logic. Extracting `ensureDiarizeTask` first reduces duplicated DB behavior.
- **UX risk:** Users may also expect library multi-select and folder watch. Keep MVP to upload multi-select; add library multi-select as a follow-up.

---

## Recommended Implementation Order

1. Schema + repo.
2. Diarize helper extraction.
3. Runner.
4. API.
5. Multi-file upload create dialog.
6. Batch monitor.
7. Full verification and docs.
