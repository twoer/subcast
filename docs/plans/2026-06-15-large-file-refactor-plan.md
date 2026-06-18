# Large File Refactor Plan

Date: 2026-06-15

Branch context: `codex/main-architecture-analysis`

Status: Phase 1 and Phase 2 completed. Shared queue task state types were
extracted to `server/utils/queueTypes.ts`; `TranscribeQueue` and `LLMQueue` were
split into dedicated modules. `server/utils/queue.ts` remains as a compatibility
barrel for existing public imports.

## Goal

Reduce risk in the largest code coordination surfaces without doing a broad cosmetic rewrite. The plan targets files where size now correlates with mixed responsibilities, regression risk, or slower reviews.

This is not a "split by line count" project. Each step should preserve behavior and add or reuse focused tests.

## Current Hotspots

| File | Approx. lines | Recommendation |
| --- | ---: | --- |
| `server/utils/queue.ts` | 1692 | Highest priority. Split by queue responsibility when touching queue behavior. |
| `app/pages/player/[hash].vue` | 1280 | High priority. Extract non-core operation logic and panels. |
| `app/pages/setup-wizard/index.vue` | 916 | Medium priority. Split Whisper and LLM steps. |
| `app/pages/index.vue` | 887 | Medium priority. Extract upload, batch staging, and desktop open-file handling. |
| `desktop/main.ts` | 568 | Defer. Large but cohesive Electron lifecycle file. |
| `electron-builder.config.cjs` | 546 | Defer. Large because packaging is explicit; keep centralized for now. |
| `app/components/InsightsPanel.vue` | 536 | Defer unless insight UX changes. Functionally focused. |

## Non-Goals

- Do not refactor docs, i18n JSON, `pnpm-lock.yaml`, demo media, or generated artifacts just because they are large.
- Do not split files if the extracted unit has no stable responsibility.
- Do not combine this with UI redesign.
- Do not move server code into desktop or app code into server.
- Do not change task semantics, queue ordering, persistence, or retry behavior during mechanical extraction.

## Phase 1: Queue Extraction Prep

Target: `server/utils/queue.ts`

### Why

This file combines transcription, LLM translation, AI insights, SSE frame handling, cancellation, shutdown, and task resurrection. It has tests, but future queue changes are expensive to review because unrelated task kinds are colocated.

### Steps

1. Extract shared frame helpers:
   - Error frame construction.
   - Done/progress frame helpers.
   - Common SSE replay helpers if they are truly shared.
   - Status: deferred. The current frame construction is still tightly coupled
     to each queue's DB/status branch, so extracting it now would add a weak
     abstraction rather than reduce risk.
2. Extract shared active-task types:
   - Keep `TranscribeQueue` and `LLMQueue` behavior unchanged.
   - Convert LLM active task state to a discriminated union only if tests clearly cover it.
   - Status: done. Extracted active task and task summary types to
     `server/utils/queueTypes.ts`. The LLM active state shape remains unchanged.
3. Keep existing public exports:
   - `transcribeQueue`
   - `llmQueue`
   - `translateQueue`
   - Status: done. `queue.ts` also continues to export the previous public type
     names (`ActiveLLMTask`, `TranscribeTaskSummary`, etc.) as compatibility aliases.

### Suggested Files

- `server/utils/queueFrames.ts`
- `server/utils/queueTypes.ts`

### Verification

```bash
pnpm test:run server/utils/__tests__/queue.test.ts server/utils/__tests__/llm-queue.test.ts
pnpm typecheck
```

### Stop Condition

Stop after helper/type extraction. Do not split `TranscribeQueue` and `LLMQueue` in the same PR unless a queue behavior change requires it.

## Phase 2: Queue Responsibility Split

Target: `server/utils/queue.ts`

Status: done. `TranscribeQueue` now lives in `server/utils/transcribeQueue.ts`,
`LLMQueue` and the translate facade live in `server/utils/llmQueue.ts`, and
`server/utils/queue.ts` exports the same public singleton/type names as before.

### Why

After Phase 1, splitting the queue classes becomes lower risk because shared pieces are already separate.

### Steps

1. Move `TranscribeQueue` into `server/utils/transcribeQueue.ts`.
2. Move `LLMQueue` into `server/utils/llmQueue.ts`.
3. Keep a compatibility barrel in `server/utils/queue.ts` that exports the same singleton names.
4. Confirm all import paths still work.

### Verification

```bash
pnpm test:run server/utils/__tests__/queue.test.ts server/utils/__tests__/llm-queue.test.ts server/utils/__tests__/batch-runner.test.ts
pnpm typecheck
pnpm exec eslint server/utils/queue.ts server/utils/queueTypes.ts server/utils/transcribeQueue.ts server/utils/llmQueue.ts server/utils/insightTasks.ts
```

### Risk

Medium. Queue singletons and module load order can be subtle. Keep this phase separate from behavior changes.

## Phase 3: Player Page Operation Extraction

Target: `app/pages/player/[hash].vue`

### Why

The player page is the largest frontend file and mixes media playback, subtitle rendering, search, retranscription, waveform loading, diarization, speaker rename, export dialogs, and keyboard help.

### Preferred Extraction Order

1. Waveform loader:
   - Move `/api/waveform` fetch and seek bridge into `useWaveformLoader`.
   - Keep `WaveformBar.vue` unchanged.
2. Retranscription action:
   - Move confirm dialog state and `/api/transcribe/retry` call into `useRetranscribeAction`.
3. Diarization actions:
   - Move run, reconsolidate, rename speaker handlers into `usePlayerDiarizeActions`.
4. Optional panel components:
   - Extract template sections only after script state is already isolated.

### Suggested Files

- `app/composables/useWaveformLoader.ts`
- `app/composables/useRetranscribeAction.ts`
- `app/composables/usePlayerDiarizeActions.ts`

### Verification

```bash
pnpm typecheck
pnpm exec eslint app/pages/player/[hash].vue app/composables/useWaveformLoader.ts app/composables/useRetranscribeAction.ts app/composables/usePlayerDiarizeActions.ts
```

Manual QA:

- Open a cached video.
- Play/pause, seek, keyboard shortcuts.
- Search subtitles.
- Switch subtitle language.
- Open export dialog.
- Run diarization or verify existing diarization controls.

### Risk

Medium-high. Player regressions are user-visible. Keep extraction behavior-preserving and test manually.

## Phase 4: Setup Wizard Step Split

Target: `app/pages/setup-wizard/index.vue`

### Why

The page contains two similar but distinct workflows: Whisper install and LLM install. `useInstallTask.ts` already extracted polling/start/cancel mechanics, so the next clean boundary is step UI.

### Steps

1. Extract `WhisperInstallStep.vue`.
2. Extract `LlmInstallStep.vue`.
3. Keep navigation, route parsing, and final settings persistence in `index.vue`.
4. Pass only explicit props and emits.

### Suggested Files

- `app/pages/setup-wizard/components/WhisperInstallStep.vue`
- `app/pages/setup-wizard/components/LlmInstallStep.vue`

### Verification

```bash
pnpm typecheck
pnpm exec eslint app/pages/setup-wizard/index.vue app/pages/setup-wizard/useInstallTask.ts app/pages/setup-wizard/components/WhisperInstallStep.vue app/pages/setup-wizard/components/LlmInstallStep.vue
```

Manual QA:

- Fresh setup path.
- Manage-from-settings path with `?step=1` and `?step=2`.
- Existing model scan, symlink/copy choices, download choice.
- Cancel install.

### Risk

Medium. The wizard has many conditional states. Preserve current data flow first; do not redesign.

## Phase 5: Home Page Workflow Extraction

Target: `app/pages/index.vue`

### Why

The home page coordinates normal upload, subtitle pairing, batch staging, task cancellation, recent library, desktop setup gaps, and OS open-file handoff.

### Preferred Extraction Order

1. `useHomeUpload`
   - File type detection.
   - Video/subtitle pair selection.
   - Single upload submission.
2. `useBatchStaging`
   - Stage uploads.
   - Cleanup stage IDs.
   - Batch dialog payload handling.
3. `useDesktopOpenFileUpload`
   - OS file event wiring.
   - Desktop upload-from-path API call.

### Suggested Files

- `app/composables/useHomeUpload.ts`
- `app/composables/useBatchStaging.ts`
- `app/composables/useDesktopOpenFileUpload.ts`

### Verification

```bash
pnpm typecheck
pnpm exec eslint app/pages/index.vue app/composables/useHomeUpload.ts app/composables/useBatchStaging.ts app/composables/useDesktopOpenFileUpload.ts
```

Manual QA:

- Drag/drop one video.
- Drag/drop video plus subtitle.
- Batch upload multiple videos.
- Cancel pending batch dialog and confirm staged temp cleanup.
- Open media from desktop shell if running Electron.

### Risk

Medium. Upload and batch staging touch filesystem/cache state through APIs. Keep API contracts unchanged.

## Recommended Sequence

1. Phase 1: queue helpers/types.
2. Phase 3.1 and 3.2: waveform and retranscription extraction from player.
3. Phase 5.1: home upload extraction.
4. Phase 2: queue responsibility split, only after Phase 1 has settled.
5. Phase 4: setup wizard split when the wizard is next touched.
6. Phase 5.2 and 5.3: batch staging and desktop open-file extraction.

## PR Sizing

Keep each PR small enough to review in one sitting:

- Queue Phase 1: one PR.
- Queue Phase 2: one PR.
- Player waveform/retranscribe: one PR.
- Player diarization actions: one PR.
- Setup wizard steps: one PR.
- Home upload/batch/desktop open-file: one or two PRs depending on diff size.

## Success Criteria

- `server/utils/queue.ts` becomes a compatibility export or a much smaller orchestration file.
- `player/[hash].vue` no longer owns API command logic for waveform, retranscribe, and diarization.
- `setup-wizard/index.vue` composes two step components rather than rendering both workflows inline.
- `index.vue` delegates upload and batch state machines to composables.
- No user-visible behavior changes are introduced by extraction-only PRs.
