# Model UX Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the post-0.5.1 local-model control plane visible and understandable to users without rushing a 0.5.2 release.

**Architecture:** Keep the current llama.cpp/Qwen3 runtime behavior stable. Start by proving the player translation UI path, then surface model/task policy information through existing desktop APIs, settings UI, queue badges, and Insight progress/error states. Do not add automatic model routing beyond the policy-aware single-model behavior already landed.

**Tech Stack:** Nuxt 4, Vue 3, TypeScript, Nitro API routes, better-sqlite3, llama.cpp `llama-server`, Vitest, Electron desktop APIs, Tailwind CSS, lucide-vue-next.

---

## Scope And Priorities

This plan assumes the four post-0.5.1 commits already exist:

- `feat: add local llm capability benchmarks`
- `feat: report dry-run llm task policy`
- `feat: enable policy-aware llm invocation`
- `docs: record 0.5.1 model smoke baseline`

Priority order:

1. Verify and, if needed, fix the player translation UI path.
2. Surface model/task policy decisions in Settings so users understand what each AI action will use.
3. Improve task-list and file-row status copy for LLM model errors.
4. Make long Insight progress clearer without changing the map/reduce algorithm.
5. Run packaged smoke and decide whether the accumulated changes deserve a later version bump.

Do not change release version in this plan.

## Task 1: Player Translation UI Smoke And Guardrails

**Files:**

- Read: `app/pages/player/[hash].vue`
- Read: `app/composables/useSubtitleStreams.ts`
- Read: `server/api/translate.get.ts`
- Read: `server/utils/llmQueue.ts`
- Test: `app/composables/__tests__/useSubtitleStreams.test.ts` if it exists, otherwise create focused tests near existing composable tests
- Test: `server/utils/__tests__/translate.test.ts`

**Step 1: Reproduce the UI path**

Run the packaged app:

```bash
open /Users/zhangkun/Documents/Code/my-2026/subcast/dist-electron/mac-arm64/Subcast.app
```

Use:

```text
/Users/zhangkun/Documents/Backup/downloads-260816/测试音频/sample-3s.mp3
/Users/zhangkun/Documents/Backup/downloads-260816/测试音频/0413_59s.mp3
```

Expected:

- Import succeeds.
- Original transcript is visible.
- Switching to a target language opens `/api/translate`.
- `/Users/zhangkun/Library/Application Support/subcast/logs/2026-08-17.jsonl` records `translate_completed`.
- SQLite `translate_tasks` has a recent `completed` row.

Useful checks:

```bash
rg -n '"event":"translate_|MODEL_NOT_CONFIGURED|PARSE_FAILED' \
  '/Users/zhangkun/Library/Application Support/subcast/logs/2026-08-17.jsonl'

sqlite3 -header -column \
  '/Users/zhangkun/Library/Application Support/subcast/data.sqlite' \
  "select id, substr(video_sha,1,12) as video, target_lang, status, model, progress_pct, error_code, error_msg, datetime(created_at/1000,'unixepoch') as created_utc, datetime(completed_at/1000,'unixepoch') as completed_utc from translate_tasks order by created_at desc limit 5;"
```

**Step 2: If the UI does not trigger translation, write the failing test**

Test the composable path around `openTranslateStream(lang)` in `app/composables/useSubtitleStreams.ts`.

Minimum assertion:

```ts
expect(eventSourceUrls).toContain('/api/translate?hash=<hash>&lang=zh-CN');
expect(langStatus.value['zh-CN']).toBe('running');
```

Run:

```bash
pnpm vitest --run app/composables/__tests__/useSubtitleStreams.test.ts
```

Expected: FAIL if translation is not triggered correctly.

**Step 3: Implement the minimal fix**

Likely areas:

- `app/pages/player/[hash].vue`: language tab/change handler not calling `openTranslateStream`.
- `app/composables/useSubtitleStreams.ts`: guard exits too early because cached language state is stale.
- `server/api/translate.get.ts`: SSE error handling prevents UI retry.

Do not change LLM policy code unless the failure proves policy selection is involved.

**Step 4: Run verification**

```bash
pnpm vitest --run server/utils/__tests__/translate.test.ts
pnpm typecheck
```

Then rerun the packaged UI translation smoke.

**Step 5: Commit**

```bash
git add app/pages/player/[hash].vue app/composables/useSubtitleStreams.ts app/composables/__tests__/useSubtitleStreams.test.ts server/api/translate.get.ts server/utils/__tests__/translate.test.ts
git commit -m "fix: harden player translation trigger"
```

Only add files that actually changed.

## Task 2: Surface Task Model Policy In Settings

**Files:**

- Modify: `server/api/desktop/models.get.ts`
- Modify: `app/pages/settings/components/Models.vue`
- Modify: `app/types/setupWizard.ts` or create a shared app-side model type if Settings should not depend on setup wizard types
- Modify: locale/i18n files if present in the app; otherwise follow the existing translation pattern in the touched component
- Test: `server/utils/__tests__/taskModelPolicy.test.ts`
- Test: add or update a desktop models API test if one exists

**Step 1: Write the failing API test**

Expected response shape:

```ts
expect(res.llm.taskPolicies).toEqual([
  expect.objectContaining({ task: 'translate', modelId: '8b', dryRun: true }),
  expect.objectContaining({ task: 'polish', modelId: '8b', dryRun: true }),
  expect.objectContaining({ task: 'insight', modelId: '8b', dryRun: true }),
]);
```

Run:

```bash
pnpm vitest --run server/utils/__tests__/taskModelPolicy.test.ts
```

Expected: PASS for policy helper, FAIL for the API test until `server/api/desktop/models.get.ts` exposes it.

**Step 2: Add model policy data to the Settings models API**

In `server/api/desktop/models.get.ts`, import:

```ts
import { taskModelPolicyDecisions } from '../../utils/taskModelPolicy';
```

Return under `llm`:

```ts
taskPolicies: settings.llmModel
  ? taskModelPolicyDecisions({
      configuredModel: settings.llmModel,
      installedModels: llmInstalled.map((m) => m.name),
      dryRun: true,
    })
  : [],
```

Expected behavior:

- No raw model paths are added.
- Missing active model still keeps `needsDownload`.
- Decisions remain dry-run display metadata.

**Step 3: Render compact task policy rows**

In `app/pages/settings/components/Models.vue`, add a compact section below the active LLM model controls.

UI expectations:

- Three rows for user-facing tasks: Translate, Polish, Insight.
- Each row shows selected model display name using `llmDisplayName(modelId)`.
- If `fallback` is true, show a small warning badge.
- If `llmNeedsDownload` is true, show the existing download warning first; the policy rows should not imply the model is usable.

Layout rules:

- Icon plus text must use `inline-flex` or `flex` with `items-center` and one consistent `gap-*`.
- lucide icons must have explicit size and `shrink-0`.
- Do not use `ml-*` or `mr-*` to separate icon and text.
- Keep it compact; do not add a marketing-style explainer card.

**Step 4: Run verification**

```bash
pnpm typecheck
pnpm lint
```

Expected:

- PASS.
- Existing website warnings may remain unchanged.

**Step 5: Commit**

```bash
git add server/api/desktop/models.get.ts app/pages/settings/components/Models.vue app/types/setupWizard.ts
git commit -m "feat: show llm task policy in settings"
```

## Task 3: Improve Queue And File Row Model/Error Visibility

**Files:**

- Modify: `app/pages/index.vue`
- Modify: `app/composables/useQueueList.ts`
- Modify: `app/components/FileStatusBadges.vue`
- Modify: `app/utils/fileStatus.ts`
- Modify: `server/api/queue/list.get.ts` only if additional safe fields are required
- Test: add/update `app/utils/__tests__/fileStatus.test.ts` if present, otherwise create it
- Test: `server/utils/__tests__/queue-list-privacy.test.ts`

**Step 1: Write failing tests for file status**

Cover:

- Translate failure with `MODEL_NOT_CONFIGURED` produces a failed status.
- Insight error does not show as done just because a stale artifact exists.
- Queue item model ids `4b`, `8b`, `14b`, and placeholder `llm` map to user-facing names.

Run:

```bash
pnpm vitest --run app/utils/__tests__/fileStatus.test.ts server/utils/__tests__/queue-list-privacy.test.ts
```

Expected: FAIL for any newly specified behavior not implemented yet.

**Step 2: Normalize model display names**

In `app/pages/index.vue`, update `displayModel(model: string)`:

```ts
case '4b': return 'Qwen3-4B';
case '8b': return 'Qwen3-8B';
case '14b': return 'Qwen3-14B';
```

Keep the existing fallbacks:

- `sensevoice` -> `SenseVoice`
- `whisper` -> `Whisper`
- `llm` -> `Qwen3`

**Step 3: Show actionable LLM errors**

Use `errorCode` first, not `errorMsg`, for user-visible copy. Preserve the existing privacy behavior:

- Do not show local filesystem paths.
- Do not show llama-server stderr.
- Do not show prompt/model output.

If a queue item has `MODEL_NOT_CONFIGURED`, the UI should point the user to Settings/models rather than only saying “failed”.

**Step 4: Run verification**

```bash
pnpm vitest --run app/utils/__tests__/fileStatus.test.ts server/utils/__tests__/queue-list-privacy.test.ts
pnpm typecheck
pnpm lint
```

**Step 5: Commit**

```bash
git add app/pages/index.vue app/composables/useQueueList.ts app/components/FileStatusBadges.vue app/utils/fileStatus.ts app/utils/__tests__/fileStatus.test.ts server/api/queue/list.get.ts server/utils/__tests__/queue-list-privacy.test.ts
git commit -m "feat: clarify model task errors"
```

Only add files that actually changed.

## Task 4: Clarify Long Insight Progress

**Files:**

- Modify: `server/utils/insightTasks.ts`
- Modify: `server/utils/contextBudget.ts` only if extra plan metadata is required
- Modify: `app/components/InsightsPanel.vue`
- Test: `server/utils/__tests__/insights-api.test.ts`
- Test: `server/utils/__tests__/contextBudget.test.ts`

**Step 1: Write failing tests for progress metadata**

Add an assertion in `server/utils/__tests__/insights-api.test.ts` that long transcripts emit:

```ts
expect(progressFrame.data).toMatchObject({
  phase: 'map',
  doneWindows: expect.any(Number),
  totalWindows: expect.any(Number),
  progressPct: expect.any(Number),
});
```

If already covered, add coverage for a final `reduce` phase frame.

Run:

```bash
pnpm vitest --run server/utils/__tests__/insights-api.test.ts server/utils/__tests__/contextBudget.test.ts
```

Expected: PASS if the backend already emits enough metadata.

**Step 2: Improve the UI copy only**

In `app/components/InsightsPanel.vue`, make `generatingLabel` and nearby progress text distinguish:

- Reading transcript chunks
- Combining summaries
- Generating final chapters/summary

Keep existing compact layout. Use existing progress frames:

- `phase`
- `doneWindows`
- `totalWindows`
- `progressPct`

Do not add extra backend calls.

**Step 3: Add one UI state test if the project has component-test precedent**

If no component test pattern exists for `InsightsPanel.vue`, rely on typecheck/lint and packaged smoke.

**Step 4: Run verification**

```bash
pnpm vitest --run server/utils/__tests__/insights-api.test.ts server/utils/__tests__/contextBudget.test.ts
pnpm typecheck
pnpm lint
```

**Step 5: Commit**

```bash
git add server/utils/insightTasks.ts server/utils/contextBudget.ts app/components/InsightsPanel.vue server/utils/__tests__/insights-api.test.ts server/utils/__tests__/contextBudget.test.ts
git commit -m "feat: clarify long insight progress"
```

Only add files that actually changed.

## Task 5: Packaged Smoke Checklist And Release Decision

**Files:**

- Modify: `docs/performance-baseline.md`
- Modify: `docs/plans/2026-08-17-next-model-ux-hardening.md`
- Read: `docs/release-runbook.md`
- Read: `docs/smoke-tests.md`

**Step 1: Run automated checks**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected:

- All pass.
- Existing website Vue warnings may remain only if unchanged.

**Step 2: Run packaged verification only if packaging-related files changed**

If no packaging files changed, this step can be skipped.

If packaging or sidecar paths changed:

```bash
pnpm build:desktop:mac
node scripts/verify-mac-artifact.mjs
```

Expected: PASS.

**Step 3: Run manual UI smoke**

Use the same two local test media files:

```text
/Users/zhangkun/Documents/Backup/downloads-260816/测试音频/sample-3s.mp3
/Users/zhangkun/Documents/Backup/downloads-260816/测试音频/0413_59s.mp3
```

Verify:

- Transcribe completes.
- Translate completes and appears in UI.
- Polish completes.
- Insight completes.
- Long Insight progress copy is clear.
- Missing-model errors point to model setup without leaking paths.
- Diagnostics export has no local paths, prompt text, transcript snippets, or model output snippets.

**Step 4: Record the checkpoint**

Append a dated checkpoint to `docs/performance-baseline.md`:

- commit range
- test commands
- UI smoke result
- any known warnings
- release decision: no version bump yet / prepare 0.5.2

**Step 5: Commit**

```bash
git add -f docs/performance-baseline.md docs/plans/2026-08-17-next-model-ux-hardening.md
git commit -m "docs: record model ux hardening smoke"
```

## Verification Plan

Before declaring this plan complete:

```bash
pnpm vitest --run \
  server/utils/__tests__/translate.test.ts \
  server/utils/__tests__/taskModelPolicy.test.ts \
  server/utils/__tests__/queue-list-privacy.test.ts \
  server/utils/__tests__/insights-api.test.ts \
  server/utils/__tests__/contextBudget.test.ts
pnpm typecheck
pnpm lint
pnpm test
```

Manual packaged checks:

- UI translation creates a recent `translate_tasks` row.
- Settings shows task-to-model decisions.
- Queue/list errors show friendly copy.
- Insight long-running state shows map/reduce progress clearly.
- Diagnostics remain content/path safe.

## Stop Conditions

Stop and reassess before continuing if:

- UI translation does not trigger `/api/translate` and cannot be reproduced in a focused test.
- Diagnostics leak local paths, prompt text, transcript text, or model output.
- Settings UI suggests a missing model is usable.
- Any change requires broad runtime model routing beyond the current policy-aware single-model behavior.
- Packaging verification regresses.

## Suggested Commit Order

1. `fix: harden player translation trigger`
2. `feat: show llm task policy in settings`
3. `feat: clarify model task errors`
4. `feat: clarify long insight progress`
5. `docs: record model ux hardening smoke`
