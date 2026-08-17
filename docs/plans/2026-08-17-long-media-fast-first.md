# Long Media Fast-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make long audio/video and batch jobs produce usable original subtitles quickly, then run translation, polish, insights, and diarization as optional background enhancements.

**Architecture:** Keep existing transcribe, LLM, and diarize workers. Add a batch execution strategy that can split work into a fast transcribe pass followed by an enhancement pass, plus UI presets that make long-media cost visible before starting. Avoid rewriting queue internals unless telemetry shows the fast-first strategy is not enough.

**Tech Stack:** Nuxt 4, Vue 3, TypeScript, Nitro API routes, better-sqlite3, Vitest, existing `BatchOptions`, `batchRunner`, `LLMQueue`, and diarization utilities.

---

## Context

The 0.5.1 smoke test on `091160797f56c44738538cd11c6612c0.mp4` showed:

- Media duration: 1511s, about 25m11s.
- Transcribe completed in about 79s using Whisper packed mode.
- Translate and polish became the long pole, both running through Qwen3-8B.
- Batch execution currently processes one file end-to-end before starting the next file.

The right product behavior for long media is not "make every optional AI task magically instant." It is "give users the transcript fast, then make extra AI work explicit and resumable."

---

## Task 1: Extend Batch Options With Execution Strategy

**Files:**
- Modify: `shared/batch.ts`
- Modify: `server/utils/batchRepo.ts`
- Test: `server/utils/__tests__/batch-repo.test.ts`

**Step 1: Write the failing type/schema test**

Add a test that creates a batch with `executionStrategy: 'fast_first'` and verifies options round-trip through `getBatchJob()`.

```ts
it('persists fast-first batch execution strategy', () => {
  const { id } = createBatchJob({
    name: 'Long videos',
    preset: 'long_media_fast_first',
    options: {
      whisperModel: 'base',
      targetLangs: ['zh-CN'],
      insights: true,
      diarize: true,
      executionStrategy: 'fast_first',
    },
    videoShas: [HASH_A],
  });

  expect(getBatchJob(id)?.options.executionStrategy).toBe('fast_first');
});
```

**Step 2: Run test to verify it fails or typecheck catches missing field**

Run:

```bash
pnpm vitest --run server/utils/__tests__/batch-repo.test.ts
pnpm typecheck
```

Expected: TypeScript complains until `BatchOptions` includes the new field.

**Step 3: Add the minimal shared type**

In `shared/batch.ts`:

```ts
export type BatchExecutionStrategy = 'complete_each_file' | 'fast_first';

export interface BatchOptions {
  whisperModel: string;
  targetLangs: string[];
  insights: boolean;
  insightLanguage?: 'zh-CN' | 'en';
  diarize: boolean;
  diarizeTopK?: number;
  executionStrategy?: BatchExecutionStrategy;
}
```

Default omitted field to existing behavior in runner code, not in DB migration.

**Step 4: Run tests**

Run:

```bash
pnpm vitest --run server/utils/__tests__/batch-repo.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/batch.ts server/utils/__tests__/batch-repo.test.ts
git commit -m "feat: add batch execution strategy option"
```

---

## Task 2: Add Fast-First Runner Behavior

**Files:**
- Modify: `server/utils/batchRunner.ts`
- Test: `server/utils/__tests__/batch-runner.test.ts`

**Step 1: Write the failing runner test**

Add a test that proves fast-first completes transcription for all files before running enhancements for the first file.

```ts
it('fast-first transcribes every file before running enhancements', async () => {
  const { id } = createBatchJob({
    name: 'Long batch',
    preset: 'long_media_fast_first',
    options: options({
      targetLangs: ['zh-CN'],
      insights: true,
      diarize: true,
      executionStrategy: 'fast_first',
    }),
    videoShas: [HASH_A, HASH_B],
  });
  const calls: string[] = [];

  await runBatchOnce(id, { adapter: fakeAdapter(calls) });

  expect(calls.slice(0, 2)).toEqual(['a:transcribe', 'b:transcribe']);
  expect(calls).toContain('a:translate:zh-CN');
  expect(calls).toContain('b:translate:zh-CN');
  expect(getBatchJob(id)).toMatchObject({
    status: 'completed',
    doneItems: 2,
    failedItems: 0,
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest --run server/utils/__tests__/batch-runner.test.ts
```

Expected: FAIL because current calls start enhancements for `a` before transcribing `b`.

**Step 3: Split item work into transcribe pass and enhancement pass**

In `server/utils/batchRunner.ts`, introduce helpers:

```ts
async function runItemTranscribeOnly(
  batchId: string,
  item: BatchItemSummary,
  adapter: BatchRunnerAdapter,
  options: BatchOptions,
): Promise<void> {
  assertBatchActive(batchId);
  if (!adapter.hasTranscript(item.videoSha)) {
    markItemStep(item.id, 'transcribe', 'running');
    await adapter.runTranscribe(item.videoSha, options.whisperModel);
    assertBatchActive(batchId);
    markItemStep(item.id, 'transcribe', 'done');
  } else if (item.stepStatus.transcribe !== 'done') {
    markItemStep(item.id, 'transcribe', 'skipped');
  }
}
```

Then keep translate/insight/diarize in a second helper:

```ts
async function runItemEnhancements(
  batchId: string,
  item: BatchItemSummary,
  adapter: BatchRunnerAdapter,
  options: BatchOptions,
): Promise<void> {
  // Move existing translate, insights, and diarize blocks here.
}
```

Preserve existing `runItem()` by composing both helpers for default behavior:

```ts
async function runItem(...) {
  await runItemTranscribeOnly(batchId, item, adapter, options);
  await runItemEnhancements(batchId, item, adapter, options);
}
```

**Step 4: Add a fast-first branch in `runBatchOnce()`**

Use `job.options.executionStrategy ?? 'complete_each_file'`.

For fast-first:

1. Iterate current job items and run `runItemTranscribeOnly()`.
2. Recompute after each item.
3. Iterate current job items again and run `runItemEnhancements()`.
4. Mark item completed only after enhancement pass finishes.

Keep cancellation guards before and after each await.

**Step 5: Run tests**

Run:

```bash
pnpm vitest --run server/utils/__tests__/batch-runner.test.ts
pnpm vitest --run server/utils/__tests__/batch-api.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/utils/batchRunner.ts server/utils/__tests__/batch-runner.test.ts
git commit -m "feat: transcribe batch items before enhancements"
```

---

## Task 3: Improve Batch Progress Semantics For Fast-First

**Files:**
- Modify: `server/utils/batchRepo.ts`
- Modify: `app/pages/index.vue`
- Test: `server/utils/__tests__/batch-runner.test.ts`

**Step 1: Write a failing test for intermediate state**

Add a test that starts fast-first with two files and pauses after transcription, then expects batch item `current_step` to show completed transcription without marking the whole item completed.

Use the existing async control style from `keeps cancellation terminal when the active worker settles afterward`.

**Step 2: Run the test**

Run:

```bash
pnpm vitest --run server/utils/__tests__/batch-runner.test.ts
```

Expected: FAIL until runner updates state predictably during pass transitions.

**Step 3: Add a UI label for fast-first state**

In `app/pages/index.vue`, when a batch item has completed transcribe but is waiting for enhancements, surface the batch card as:

- Done count remains final completed items.
- Summary text should not lie.
- Optional: add a second line like "Original subtitles ready for N files" only if it can be computed cheaply from batch detail or a new summary field.

Prefer no new API field in this task unless the UI cannot communicate the state cleanly.

**Step 4: Run tests and typecheck**

Run:

```bash
pnpm vitest --run server/utils/__tests__/batch-runner.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/utils/batchRepo.ts server/utils/batchRunner.ts app/pages/index.vue server/utils/__tests__/batch-runner.test.ts
git commit -m "fix: clarify fast-first batch progress"
```

---

## Task 4: Add Long-Media Presets To Batch Dialog

**Files:**
- Modify: `app/components/BatchCreateDialog.vue`
- Modify: `i18n/locales/en.json`
- Modify: `i18n/locales/zh-CN.json`
- Modify: `i18n/locales/zh-TW.json`
- Modify: `i18n/locales/ja.json`
- Modify: `i18n/locales/es.json`
- Test: `app/composables/__tests__/useBatchStaging.test.ts` if payload coverage exists; otherwise add a focused component test only if the test harness already supports component mounting.

**Step 1: Add preset IDs**

Extend `PresetId`:

```ts
type PresetId =
  | 'transcribe'
  | 'transcribe_translate'
  | 'transcribe_insights'
  | 'transcribe_translate_insights'
  | 'full'
  | 'long_media_fast_first';
```

**Step 2: Add the preset**

In `presets`:

```ts
{
  id: 'long_media_fast_first',
  icon: ListChecks,
  options: {
    targetLangs: ['zh-CN'],
    insights: false,
    diarize: false,
    executionStrategy: 'fast_first',
  },
}
```

This first version should be conservative: original subtitles and translation, no insight or diarize by default.

**Step 3: Set better default for many files**

When `count > 1`, default to `long_media_fast_first`.

```ts
watch(
  () => props.open,
  (open) => {
    if (open && props.count > 1) selectedPreset.value = 'long_media_fast_first';
  },
);
```

If that feels too aggressive in testing, use `props.count >= 3`.

**Step 4: Update i18n**

Add keys:

```json
"long_media_fast_first": "Fast subtitles first"
```

Description:

```json
"long_media_fast_first": "Runs transcription for every file first, then translation. AI summary and speaker recognition can be added later from the player."
```

Mirror across all locale files.

**Step 5: Run checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS with existing website warnings only if still present.

**Step 6: Commit**

```bash
git add app/components/BatchCreateDialog.vue i18n/locales/*.json
git commit -m "feat: add fast subtitles batch preset"
```

---

## Task 5: Let Users Add Enhancements After Transcribe

**Files:**
- Modify: `app/pages/player/[hash].vue`
- Modify: `app/components/PlayerToolbar.vue`
- Modify: `app/composables/useDiarizeStatus.ts`
- Reuse existing insight and polish actions.
- Test: `app/composables/__tests__/usePlayerDiarizeActions.test.ts`

**Step 1: Audit existing buttons**

Confirm the player already exposes:

- AI polish button.
- AI insights tab/generate action.
- Diarize run button.

Do not add duplicate commands if existing UI is sufficient.

**Step 2: Add missing CTA only where needed**

If fast-first leaves a user in the player with original subtitles plus translated subtitles, make sure the player can clearly start:

- AI polish.
- AI insights.
- Speaker recognition.

Use existing primitives and icon+text rules:

```vue
<Button class="inline-flex items-center gap-1.5">
  <Sparkles class="h-4 w-4 shrink-0" />
  <span>{{ t('player.insights.generate') }}</span>
</Button>
```

**Step 3: Add i18n if a new CTA is needed**

Keep text action-oriented, not explanatory.

**Step 4: Run focused tests**

Run:

```bash
pnpm vitest --run app/composables/__tests__/usePlayerDiarizeActions.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add app/pages/player/[hash].vue app/components/PlayerToolbar.vue app/composables/useDiarizeStatus.ts i18n/locales/*.json
git commit -m "feat: surface post-transcribe enhancements"
```

---

## Task 6: Add Long-Media Runtime Telemetry

**Files:**
- Modify: `server/utils/batchRunner.ts`
- Modify: `server/utils/transcribeQueue.ts`
- Modify: `server/utils/llmQueue.ts`
- Modify: `server/utils/diarize/diarize.ts`
- Test: Existing tests should continue passing; add log assertions only if current test helpers make it cheap.

**Step 1: Log per-stage elapsed time**

Add info logs with sanitized fields only:

```ts
logEvent({
  level: 'info',
  event: 'batch_item_stage_done',
  batchId,
  itemId: item.id,
  videoSha: item.videoSha,
  stage: 'transcribe',
  durationMs,
});
```

Do not log filenames, transcript text, prompt text, or model output.

**Step 2: Log long-media classification**

When creating or starting a batch item, log:

```ts
logEvent({
  level: 'info',
  event: 'batch_item_runtime_classified',
  batchId,
  itemId: item.id,
  durationS,
  executionStrategy: options.executionStrategy ?? 'complete_each_file',
});
```

Only include `durationS` if already available without probing another expensive path.

**Step 3: Run privacy-focused tests**

Run:

```bash
pnpm vitest --run server/utils/__tests__/logSanitize.test.ts server/utils/__tests__/queue-list-privacy.test.ts
pnpm vitest --run server/utils/__tests__/batch-runner.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add server/utils/batchRunner.ts server/utils/transcribeQueue.ts server/utils/llmQueue.ts server/utils/diarize/diarize.ts
git commit -m "chore: log long-media stage timings"
```

---

## Task 7: Optional Follow-Up, Adaptive LLM Scheduling

**Files:**
- Modify: `server/utils/runtimeProfile.ts`
- Modify: `server/utils/llmQueue.ts`
- Test: `server/utils/__tests__/runtimeProfile.test.ts`
- Test: `server/utils/__tests__/llm-queue.test.ts`

**Do this only after Tasks 1-6 ship.**

**Step 1: Capture real timings from telemetry**

Run several long videos and compare:

- Qwen3-8B one slot vs two slots.
- Translation only vs translation + polish.
- Insight enabled vs disabled.

**Step 2: Add policy if data supports it**

Possible policy:

```ts
if (taskCueCount > 200 && activeRuntimeProfile().memoryTier === 'low') {
  return 1;
}
```

Do not add this speculatively. The observed 0.5.1 run shows the machine handles two slots, but long jobs feel slow because they are doing a lot of work, not because the queue is broken.

**Step 3: Run tests**

```bash
pnpm vitest --run server/utils/__tests__/runtimeProfile.test.ts server/utils/__tests__/llm-queue.test.ts
```

**Step 4: Commit**

```bash
git add server/utils/runtimeProfile.ts server/utils/llmQueue.ts server/utils/__tests__/runtimeProfile.test.ts server/utils/__tests__/llm-queue.test.ts
git commit -m "perf: adapt llm slots for long media"
```

---

## Verification Checklist

Run before final handoff:

```bash
pnpm vitest --run server/utils/__tests__/batch-runner.test.ts server/utils/__tests__/batch-api.test.ts server/utils/__tests__/batch-repo.test.ts
pnpm vitest --run server/utils/__tests__/llm-queue-pipeline.test.ts server/utils/__tests__/llm-queue.test.ts
pnpm vitest --run server/utils/__tests__/logSanitize.test.ts server/utils/__tests__/queue-list-privacy.test.ts
pnpm typecheck
pnpm lint
```

Manual QA:

1. Drop a batch with at least one 20+ minute video and one short video.
2. Select "Fast subtitles first".
3. Confirm every file gets original subtitles before optional stages dominate runtime.
4. Open a completed original subtitle while other enhancements continue in the background.
5. Confirm canceling the batch keeps canceled state terminal.
6. Confirm logs contain no raw filenames, transcript text, prompt text, or model output.

---

## Recommendation

Ship Tasks 1-4 first as 0.5.2. They change the user-perceived behavior without changing LLM internals. Task 5 is likely small if existing player controls are enough. Task 6 should land with the release because it gives evidence for the next performance pass.

Do not start with adaptive LLM scheduling. That is tempting, but the current evidence says queue policy is less important than letting users get usable subtitles before optional AI work finishes.

---

## Packaged Smoke Result — 2026-08-18

Status: Tasks 1-6 have been implemented and verified on a packaged macOS arm64 build.

Packaged artifact:

- Built `dist-electron/Subcast-0.5.1-arm64.dmg` with `pnpm build:desktop:mac`.
- Mounted `/Volumes/Subcast 0.5.1` successfully.
- Verified packaged `whisper-cli --help`, `llama-server --help`, `ffmpeg`, and `yt-dlp` execute.
- Verified whisper rpaths use `@loader_path/whisper-libs` and `@loader_path`; no local build-machine paths were found in the packaged sidecar load-command scan.

Fast-first batch smoke:

- Batch id: `4725b454-12ab-4d70-81cc-dc0d2ed89453`.
- Preset: `long_media_fast_first`.
- Execution strategy: `fast_first`.
- Result: 10 total, 10 completed, 0 failed.
- Stage telemetry: 10 `transcribe` events followed by 10 `translate` events.
- The fast-first preset skipped `insights` and `diarize`, matching the conservative default.
- No warn/error events were logged for the fast-first batch.
- Model resources released after the run: `whisper-server` exited after transcription, and `llama-server` exited after its idle keepalive window.

Follow-up decision:

- Treat this as release-candidate evidence for 0.5.2.
- Do not implement Task 7 yet. The smoke supports the current execution-order change; it does not yet justify adaptive LLM scheduling.
