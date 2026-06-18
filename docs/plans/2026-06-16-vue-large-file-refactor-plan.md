# Vue Large File Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce the largest Vue page files by extracting stable state machines and focused UI sections without changing user-visible behavior.

**Architecture:** Keep route pages as orchestration shells. Move API calls, DOM timers, and workflow state into composables with unit tests; move only cohesive template sections into components after the state boundary is stable.

**Tech Stack:** Nuxt 4, Vue 3 `<script setup>`, TypeScript, Vitest, pnpm, existing app components/composables.

---

## Current Hotspots

| File | Lines | Priority | Reason |
| --- | ---: | --- | --- |
| `app/pages/player/[hash].vue` | 1280 | P0 | Mixes playback, waveform, retranscribe, diarize, subtitle list, export, settings, and keyboard behavior. |
| `app/pages/setup-wizard/index.vue` | 916 | P1 | Renders Whisper and LLM install workflows in one page even though `useInstallTask.ts` already separates polling mechanics. |
| `app/pages/index.vue` | 887 | P1 | Mixes single upload, subtitle pairing, batch staging, desktop open-file, health polling, queue cancellation, and recent library. |
| `app/components/InsightsPanel.vue` | 536 | P2 | Large but cohesive; can be improved after page-level risk is reduced. |
| `app/pages/settings/components/Models.vue` | 447 | P3 | Medium-sized, leave until model settings are next touched. |
| `app/components/AppHeader.vue` | 416 | P3 | Medium-sized and navigation-focused; defer unless layout changes are needed. |

## Non-Goals

- Do not redesign the UI.
- Do not change API contracts.
- Do not change upload, transcription, translation, diarization, or insight semantics.
- Do not combine unrelated large-file extractions in one commit.
- Do not move browser-only logic into `server/`, `desktop/`, or `shared/`.
- Do not split template sections before the related state/API logic has a stable boundary.

## Verification Baseline

Run before the first implementation task and after each phase:

```bash
pnpm typecheck
pnpm exec eslint app/pages/player/[hash].vue app/pages/index.vue app/pages/setup-wizard/index.vue app/components/InsightsPanel.vue
```

When new tests are added:

```bash
pnpm vitest --run app/composables/__tests__/<test-file>.test.ts
```

Manual QA is required for any player or upload-page change.

---

## Phase 1: Player Low-Risk Composable Extraction

Target: `app/pages/player/[hash].vue`

Outcome: Remove API/DOM workflow logic from the player page while keeping the template mostly intact.

### Task 1: Extract waveform loading

**Files:**
- Create: `app/composables/useWaveformLoader.ts`
- Create: `app/composables/__tests__/useWaveformLoader.test.ts`
- Modify: `app/pages/player/[hash].vue`

**Steps:**

1. Write tests for `useWaveformLoader`:
   - Loads `/api/waveform?hash=<hash>`.
   - Stores `peaks` on success.
   - Stores an empty array or null on failure, matching current page behavior.
   - `seek(seconds)` updates the injected media element when available.

2. Implement `useWaveformLoader` with a small injected fetcher option for tests:

```ts
export interface WaveformPayload {
  version: number;
  peaks: number[];
}

export function useWaveformLoader(
  hash: Ref<string> | ComputedRef<string>,
  videoRef: Ref<HTMLVideoElement | null>,
  options?: { fetcher?: typeof $fetch },
) {
  const peaks = ref<number[] | null>(null);

  async function load(): Promise<void> {
    // Preserve current page error behavior.
  }

  function seek(seconds: number): void {
    // Preserve current `onWaveformSeek` behavior.
  }

  return { peaks, load, seek };
}
```

3. Replace `waveformPeaks`, `loadWaveform`, and `onWaveformSeek` in `player/[hash].vue`.

4. Run:

```bash
pnpm vitest --run app/composables/__tests__/useWaveformLoader.test.ts
pnpm typecheck
pnpm exec eslint app/pages/player/[hash].vue app/composables/useWaveformLoader.ts app/composables/__tests__/useWaveformLoader.test.ts
```

5. Manual QA:
   - Open a cached media item.
   - Confirm waveform appears.
   - Click/drag waveform and confirm the video seeks.

6. Commit:

```bash
git add app/pages/player/[hash].vue app/composables/useWaveformLoader.ts app/composables/__tests__/useWaveformLoader.test.ts
git commit -m "refactor: extract player waveform loader"
```

### Task 2: Extract retranscribe action

**Files:**
- Create: `app/composables/useRetranscribeAction.ts`
- Create: `app/composables/__tests__/useRetranscribeAction.test.ts`
- Modify: `app/pages/player/[hash].vue`

**Steps:**

1. Write tests for:
   - Dialog open/close state.
   - Successful `POST /api/transcribe/retry`.
   - Error state on failed request.
   - Optional reload callback invocation, instead of hard-coding `window.location.reload()` inside test logic.

2. Implement `useRetranscribeAction`:

```ts
export function useRetranscribeAction(
  hash: Ref<string> | ComputedRef<string>,
  options?: {
    fetcher?: typeof $fetch;
    reload?: () => void;
  },
) {
  const showDialog = ref(false);
  const running = ref(false);
  const error = ref<string | null>(null);

  async function confirm(): Promise<void> {
    // Preserve current endpoint, payload, and reload behavior.
  }

  return { showDialog, running, error, confirm };
}
```

3. Replace `showRetranscribeDialog`, `retranscribing`, and `confirmRetranscribe` in `player/[hash].vue`.

4. Run:

```bash
pnpm vitest --run app/composables/__tests__/useRetranscribeAction.test.ts
pnpm typecheck
pnpm exec eslint app/pages/player/[hash].vue app/composables/useRetranscribeAction.ts app/composables/__tests__/useRetranscribeAction.test.ts
```

5. Manual QA:
   - Open retranscribe dialog.
   - Cancel it.
   - Trigger retranscribe on a disposable item and confirm the page reloads into the expected flow.

6. Commit:

```bash
git add app/pages/player/[hash].vue app/composables/useRetranscribeAction.ts app/composables/__tests__/useRetranscribeAction.test.ts
git commit -m "refactor: extract player retranscribe action"
```

### Task 3: Extract diarize actions

**Files:**
- Create: `app/composables/usePlayerDiarizeActions.ts`
- Create: `app/composables/__tests__/usePlayerDiarizeActions.test.ts`
- Modify: `app/pages/player/[hash].vue`

**Steps:**

1. Write tests for:
   - `run()` delegates to existing diarize status composable/action with the current hash.
   - `changeTopK(topK)` preserves the current endpoint/payload.
   - `renameSpeaker(speakerId, displayName)` preserves the current endpoint/payload and null handling.

2. Implement `usePlayerDiarizeActions` using injected API functions or fetcher options for testability.

3. Replace `handleRenameSpeaker`, `handleChangeTopK`, and `handleRunDiarize` in `player/[hash].vue`.

4. Run:

```bash
pnpm vitest --run app/composables/__tests__/usePlayerDiarizeActions.test.ts
pnpm typecheck
pnpm exec eslint app/pages/player/[hash].vue app/composables/usePlayerDiarizeActions.ts app/composables/__tests__/usePlayerDiarizeActions.test.ts
```

5. Manual QA:
   - Run diarization when original transcription is ready.
   - Change speaker count.
   - Rename a speaker.
   - Confirm grouped/list subtitle display remains unchanged.

6. Commit:

```bash
git add app/pages/player/[hash].vue app/composables/usePlayerDiarizeActions.ts app/composables/__tests__/usePlayerDiarizeActions.test.ts
git commit -m "refactor: extract player diarize actions"
```

### Phase 1 Stop Condition

Stop before extracting player template components unless the page script has become clearly simpler and all player manual QA passes.

---

## Phase 2: Home Page Upload Workflow Extraction

Target: `app/pages/index.vue`

Outcome: Move upload and batch staging state machines into composables while keeping the page template stable.

### Task 4: Extract single upload and subtitle pairing

**Files:**
- Create: `app/composables/useHomeUpload.ts`
- Create: `app/composables/__tests__/useHomeUpload.test.ts`
- Modify: `app/pages/index.vue`

**Steps:**

1. Move these pure helpers first:
   - `SUB_EXT_RE`
   - `VIDEO_EXT_RE`
   - `baseName`
   - `pickPair`

2. Write tests for:
   - One video only.
   - Video plus matching subtitle.
   - Multiple videos route to batch mode.
   - Non-media files produce the current error behavior.

3. Move single-upload API calls:
   - `uploadVideoOnly`
   - `uploadVideoWithSubs`
   - `handleFiles`
   - file input/drop handlers if useful.

4. Keep page-owned callbacks explicit:
   - navigation callback
   - library refresh callback
   - queue refresh callback

5. Run:

```bash
pnpm vitest --run app/composables/__tests__/useHomeUpload.test.ts
pnpm typecheck
pnpm exec eslint app/pages/index.vue app/composables/useHomeUpload.ts app/composables/__tests__/useHomeUpload.test.ts
```

6. Manual QA:
   - Drag/drop one video.
   - Pick one video from file input.
   - Drag/drop video plus subtitle.
   - Confirm navigation to player still works.

7. Commit:

```bash
git add app/pages/index.vue app/composables/useHomeUpload.ts app/composables/__tests__/useHomeUpload.test.ts
git commit -m "refactor: extract home upload workflow"
```

### Task 5: Extract batch staging

**Files:**
- Create: `app/composables/useBatchStaging.ts`
- Create: `app/composables/__tests__/useBatchStaging.test.ts`
- Modify: `app/pages/index.vue`

**Steps:**

1. Write tests for:
   - Staging multiple files.
   - Tracking `hashes`, `stageIds`, reused uploads, and progress.
   - Cleanup on dialog close.
   - Commit clears staged state only after success.

2. Move:
   - `stageVideoForBatch`
   - `cleanupPendingBatchStages`
   - `prepareBatchFiles`
   - `startBatchUpload`
   - `onBatchDialogOpenChange`

3. Run:

```bash
pnpm vitest --run app/composables/__tests__/useBatchStaging.test.ts
pnpm typecheck
pnpm exec eslint app/pages/index.vue app/composables/useBatchStaging.ts app/composables/__tests__/useBatchStaging.test.ts
```

4. Manual QA:
   - Drag/drop multiple videos.
   - Cancel batch dialog and confirm no stale stage state remains.
   - Start a batch and confirm queue/batch lists refresh.

5. Commit:

```bash
git add app/pages/index.vue app/composables/useBatchStaging.ts app/composables/__tests__/useBatchStaging.test.ts
git commit -m "refactor: extract batch staging workflow"
```

### Task 6: Extract desktop open-file upload

**Files:**
- Create: `app/composables/useDesktopOpenFileUpload.ts`
- Create: `app/composables/__tests__/useDesktopOpenFileUpload.test.ts`
- Modify: `app/pages/index.vue`

**Steps:**

1. Write tests for:
   - Event detail validation.
   - Successful `/api/desktop/upload-from-path` call.
   - Error state on failed upload.
   - Listener cleanup.

2. Move:
   - `handleOsOpenFile`
   - `onOsOpenFileEvent`
   - related `onMounted` / `onUnmounted` listener wiring.

3. Run:

```bash
pnpm vitest --run app/composables/__tests__/useDesktopOpenFileUpload.test.ts
pnpm typecheck
pnpm exec eslint app/pages/index.vue app/composables/useDesktopOpenFileUpload.ts app/composables/__tests__/useDesktopOpenFileUpload.test.ts
```

4. Manual QA:
   - In Electron dev mode, open a media file from the OS shell.
   - Confirm upload and navigation still work.

5. Commit:

```bash
git add app/pages/index.vue app/composables/useDesktopOpenFileUpload.ts app/composables/__tests__/useDesktopOpenFileUpload.test.ts
git commit -m "refactor: extract desktop open-file upload"
```

---

## Phase 3: Setup Wizard Step Split

Target: `app/pages/setup-wizard/index.vue`

Outcome: Keep routing, final persistence, and step navigation in `index.vue`; move Whisper and LLM install step UI into explicit child components.

### Task 7: Extract Whisper install step component

**Files:**
- Create: `app/pages/setup-wizard/components/WhisperInstallStep.vue`
- Modify: `app/pages/setup-wizard/index.vue`

**Steps:**

1. Identify the Whisper-only template section and its required props/emits.

2. Create `WhisperInstallStep.vue` with explicit props:
   - model list
   - selected model
   - install status/task state
   - scan action
   - mirror
   - disabled/running flags
   - formatting callbacks or preformatted labels, whichever keeps the component simpler.

3. Emit only user actions:
   - update selected model
   - update scan action
   - update mirror
   - start install
   - cancel install

4. Run:

```bash
pnpm typecheck
pnpm exec eslint app/pages/setup-wizard/index.vue app/pages/setup-wizard/components/WhisperInstallStep.vue
```

5. Manual QA:
   - Fresh setup step 1.
   - Manage entry with `?step=1`.
   - Existing model scan, symlink/copy choice, download choice.
   - Cancel install.

6. Commit:

```bash
git add app/pages/setup-wizard/index.vue app/pages/setup-wizard/components/WhisperInstallStep.vue
git commit -m "refactor: extract whisper setup step"
```

### Task 8: Extract LLM install step component

**Files:**
- Create: `app/pages/setup-wizard/components/LlmInstallStep.vue`
- Modify: `app/pages/setup-wizard/index.vue`

**Steps:**

1. Identify the LLM-only template section and its required props/emits.

2. Create `LlmInstallStep.vue` with explicit props and emits mirroring the Whisper step pattern.

3. Keep final settings persistence and step navigation in `index.vue`.

4. Run:

```bash
pnpm typecheck
pnpm exec eslint app/pages/setup-wizard/index.vue app/pages/setup-wizard/components/LlmInstallStep.vue
```

5. Manual QA:
   - Fresh setup step 2.
   - Manage entry with `?step=2`.
   - Low-memory warning.
   - Existing model scan and install/cancel flow.

6. Commit:

```bash
git add app/pages/setup-wizard/index.vue app/pages/setup-wizard/components/LlmInstallStep.vue
git commit -m "refactor: extract llm setup step"
```

---

## Phase 4: Shared Small Utilities

Target: duplicated browser helpers.

### Task 9: Extract clipboard feedback helper

**Files:**
- Create: `app/composables/useClipboardFeedback.ts`
- Create: `app/composables/__tests__/useClipboardFeedback.test.ts`
- Modify: `app/pages/index.vue`
- Modify: `app/components/InsightsPanel.vue`

**Steps:**

1. Write tests for:
   - Native clipboard success.
   - Textarea fallback.
   - Timed reset.

2. Replace local clipboard/reset-timer code in both files.

3. Run:

```bash
pnpm vitest --run app/composables/__tests__/useClipboardFeedback.test.ts
pnpm typecheck
pnpm exec eslint app/pages/index.vue app/components/InsightsPanel.vue app/composables/useClipboardFeedback.ts app/composables/__tests__/useClipboardFeedback.test.ts
```

4. Manual QA:
   - Copy a task id or diagnostic text on home page.
   - Copy insight markdown from the insights panel.

5. Commit:

```bash
git add app/pages/index.vue app/components/InsightsPanel.vue app/composables/useClipboardFeedback.ts app/composables/__tests__/useClipboardFeedback.test.ts
git commit -m "refactor: share clipboard feedback helper"
```

---

## Recommended Execution Order

1. Phase 1 Task 1: player waveform loader.
2. Phase 1 Task 2: player retranscribe action.
3. Phase 1 Task 3: player diarize actions.
4. Phase 2 Task 4: home upload workflow.
5. Phase 2 Task 5: batch staging workflow.
6. Phase 2 Task 6: desktop open-file upload.
7. Phase 3 Task 7: Whisper setup step.
8. Phase 3 Task 8: LLM setup step.
9. Phase 4 Task 9: shared clipboard helper.

## Success Criteria

- `app/pages/player/[hash].vue` drops below roughly 900 lines without behavior changes.
- `app/pages/index.vue` drops below roughly 650 lines and no longer owns upload/batch state machines.
- `app/pages/setup-wizard/index.vue` drops below roughly 550 lines and delegates step UI to components.
- New composables have focused Vitest coverage.
- `pnpm typecheck` and targeted eslint pass after every phase.
- Manual QA confirms player, upload, batch, desktop open-file, and setup wizard flows still work.

## Known Existing Noise

`pnpm typecheck` currently prints a Vue resolver warning for `vue-router/volar/sfc-route-blocks`, but exits successfully. Do not treat that warning as introduced by this refactor unless the exit code changes.
