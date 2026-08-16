# URL Import Branch Review

Date: 2026-06-22
Branch: `feat/url-import`
Base: `main`

## Scope

This review covers the current `feat/url-import` branch relative to `main`.
The branch adds URL-based media import through a bundled `yt-dlp` sidecar:

- home-page URL import entry and progress UI
- `useUrlImport()` composable with POST + SSE flow
- Nitro APIs for starting URL import and streaming progress
- in-memory URL import queue backed by `yt-dlp`
- `source_url` database column for URL dedup
- `yt-dlp` path resolution, fetch script, and Electron packaging
- release notes, notices, i18n strings, and disclaimer

`docs/index.html` is currently untracked and was treated as separate workspace state, not part of the branch diff.

## Findings

### P1: URL import queue can start more than one yt-dlp process

File: `server/utils/urlImportQueue.ts`

`tryStartNext()` checks `this.current` before starting work, but `this.current` is only set inside `runTask()` after an `await mkdir(...)` and after spawning `yt-dlp`.

Two nearly simultaneous imports can both observe `this.current === null`, both shift queue entries, and both enter `runTask()`, breaking the documented one-at-a-time queue contract.

Suggested fix:

- add a synchronous `starting` or `running` guard around `tryStartNext()`, or
- reserve the execution slot before the first `await`, then let `runTask()` attach the process when available.

Relevant lines:

- `server/utils/urlImportQueue.ts:214`
- `server/utils/urlImportQueue.ts:294`
- `server/utils/urlImportQueue.ts:334`

### P2: Cancel button only resets the UI; it does not cancel the server task

Files:

- `app/composables/useUrlImport.ts`
- `app/pages/index.vue`
- `server/utils/urlImportQueue.ts`

The page renders a cancel button for URL imports, and `useUrlImport.cancel()` closes the EventSource and clears UI state. It does not call the server, so the `yt-dlp` process continues downloading in the background.

The queue already has `urlImportQueue.cancel(taskId)`, but there is no API route wired to it and the composable does not retain the current `jobId`.

Suggested fix:

- store the current `jobId` in `useUrlImport()`
- add a cancel endpoint, for example `DELETE /api/import-url?jobId=...` or `DELETE /api/import-url/[id]`
- call that endpoint from `cancel()`
- keep the local UI reset as optimistic feedback, but surface failure if cancel cannot be sent

Relevant lines:

- `app/composables/useUrlImport.ts:81`
- `app/composables/useUrlImport.ts:90`
- `app/composables/useUrlImport.ts:159`
- `app/pages/index.vue:417`
- `server/utils/urlImportQueue.ts:274`

### P2: Imported media is always stored and registered as `.mp4`

File: `server/utils/urlImportQueue.ts`

After download, the queue finds a media file in the work directory, hashes it, then always renames it to `${sha}.mp4` and upserts the database row with `ext = '.mp4'`.

This is risky for direct audio URLs and non-mp4 formats. For example, a downloaded `.mp3` can be stored as `.mp4`, and `/api/video` will serve it with `video/mp4` instead of `audio/mpeg`.

Suggested fix:

- derive the actual extension from `finalFile` and persist it, or
- explicitly remux/transcode every download into a real mp4/m4a target and verify the output before writing the DB row.

Relevant lines:

- `server/utils/urlImportQueue.ts:405`
- `server/utils/urlImportQueue.ts:408`
- `server/utils/urlImportQueue.ts:416`
- `server/utils/urlImportQueue.ts:540`
- `server/api/video.get.ts:8`

### P2: URL downloads have no size or disk guard

File: `server/utils/urlImportQueue.ts`

Local uploads are capped at 2 GB, but URL imports pass through to `yt-dlp` without an equivalent max size. A large URL can consume disk until the download ends or the machine runs out of space.

Suggested fix:

- pass a `yt-dlp` max file size option, and
- verify the downloaded file size before final rename/upsert, with cleanup on failure.

Relevant lines:

- `server/api/upload.post.ts:15`
- `server/utils/urlImportQueue.ts:303`

### P3: Redundant Vue import in Nuxt composable

File: `app/composables/useUrlImport.ts`

The composable manually imports `ref` from Vue. Nuxt auto-imports Vue APIs in this project, and the local review rules flag manual Vue API imports as redundant.

Suggested fix:

- remove `import { ref } from 'vue';`

Relevant line:

- `app/composables/useUrlImport.ts:2`

## Verification

Commands run:

```bash
pnpm vitest --run server/utils/__tests__/urlImportQueue.test.ts
pnpm test
pnpm lint
pnpm typecheck
rg -n "desktop/modelManager|\\.\\./\\.\\./desktop" app || true
```

Results:

- targeted URL import tests passed: 18 tests
- full test suite passed: 55 files passed, 2 skipped; 364 tests passed, 5 skipped
- lint passed
- typecheck exited 0, with a non-fatal Vue language plugin warning for `vue-router/volar/sfc-route-blocks`
- app/desktop boundary check had no matches

## Workspace Notes

- Current branch: `feat/url-import`
- Tracking branch: `origin/feat/url-import`
- Untracked file present before this review document was added: `docs/index.html`
- `git remote show origin` could not complete because `github.com:443` was unreachable from this environment.

## Review Result

Status: not ready to merge.

The feature is coherent and test coverage exists for parser and dedup behavior, but the queue concurrency race and incomplete cancellation path should be fixed before release. The media extension/size guards are also important for real-world URL input.
