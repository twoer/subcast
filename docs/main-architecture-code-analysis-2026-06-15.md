# Main Branch Architecture And Code Analysis

Date: 2026-06-15

Branch analyzed: `main`

Baseline commit: `7b8eef2 release: 0.4.0 - multi-locale UI + page refactor + cache-clear FK fix`

Note: this audit intentionally ignores untracked files left in the working tree, such as `server/sidecars/`.

## Executive Summary

Subcast on `main` is a local-first Nuxt 4 + Electron desktop app for audio/video transcription, translation, AI summaries, waveform display, speaker diarization, and batch processing. The architecture is already product-shaped rather than prototype-shaped: it has desktop packaging rules, native sidecar handling, SQLite migrations, crash recovery, diagnostics, and a meaningful test suite.

The main strengths are:

- Clear top-level ownership between `app/`, `server/`, `desktop/`, and `shared/`.
- Strong desktop packaging work for native binaries and models.
- Good privacy posture around local inference, diagnostics, and desktop API auth.
- Solid tests around queues, database behavior, exports, diarization, and model management.

The main risks are:

- `server/` imports `desktop/modelManager/*`, so the Nitro server is coupled to desktop implementation details.
- `server/utils/queue.ts` and several Vue pages are large coordination surfaces.
- Desktop startup has an explicit unimplemented fallback when preferred port `51301` is occupied.
- Release correctness depends on gitignored `binaries/` resources that are not represented by Git cleanliness.

## Architecture Map

### Frontend: `app/`

The Vue/Nuxt app owns user workflows:

- Home upload and recent library: `app/pages/index.vue`
- Player, subtitles, translation, insight, diarization controls: `app/pages/player/[hash].vue`
- First-run setup wizard: `app/pages/setup-wizard/index.vue`
- Settings and model status: `app/pages/settings/index.vue`, `app/pages/settings/components/Models.vue`
- Library and help pages: `app/pages/library/index.vue`, `app/pages/help/index.vue`

The app layer uses composables to extract some behavior, including desktop detection, queue polling, subtitles, video controls, and player keybindings.

Current pressure point: several pages still contain substantial orchestration logic:

- `app/pages/player/[hash].vue` is about 1280 lines.
- `app/pages/index.vue` is about 887 lines.
- `app/pages/setup-wizard/index.vue` is about 916 lines.

This is manageable today, but future feature work should avoid adding more task orchestration directly to these pages.

### Backend: `server/`

Nitro routes expose the local API:

- Upload/cache/video: `server/api/upload.post.ts`, `server/api/cache/*`, `server/api/video.get.ts`
- Transcription and translation: `server/api/transcribe.get.ts`, `server/api/translate.get.ts`
- Queue visibility and cancellation: `server/api/queue/*`
- Insights: `server/api/insights.*`
- Diarization: `server/api/diarize/*`
- Batch processing: `server/api/batches/*`
- Desktop setup/model install APIs: `server/api/desktop/*`
- Diagnostics: `server/api/diagnostic.get.ts`, `server/api/diagnostics/*`

The backend's durable state is SQLite plus cache files under `SUBCAST_HOME`.

Important modules:

- Database and migrations: `server/utils/db.ts`
- Main transcribe/translate/insight queues: `server/utils/queue.ts`
- Batch runner and repositories: `server/utils/batchRunner.ts`, `server/utils/batchRepo.ts`
- Whisper integration: `server/utils/whisper.ts`, `server/utils/whisperPaths.ts`
- LLM sidecar integration: `server/utils/llmServer.ts`, `server/utils/llmBackendLlamaServer.ts`
- Diarization pipeline: `server/utils/diarize/*`
- Diagnostics/privacy: `server/utils/log.ts`, `server/utils/logSanitize.ts`

### Desktop Shell: `desktop/`

Electron owns the packaged runtime:

- Single-instance lock and file-open handoff.
- BrowserWindow lifecycle, tray, menu, updates.
- Nitro startup and shutdown.
- Desktop API token injection.
- Model scanning/install helpers.
- Native binary checks and macOS quarantine handling.

Key files:

- Main process: `desktop/main.ts`
- Nitro embed: `desktop/nitroEmbed.ts`
- Preload bridge: `desktop/preload.ts`
- Binary checks: `desktop/binaryCheck.ts`
- Model manager: `desktop/modelManager/*`
- Packaging paths: `desktop/paths.ts`

### Shared Layer: `shared/`

`shared/` is runtime-neutral and currently small. It holds:

- Model catalogs: Whisper and LLM.
- Chunking rules.
- Diarization shared types.
- Batch types.
- Install contracts.
- Error codes.

This is the right place for catalog data and pure contracts that should not depend on Electron, Node filesystem behavior, or Nitro runtime state.

## Runtime Flow

### Web / Dev

`pnpm dev` runs Nuxt normally on `0.0.0.0:3000`. SSR remains enabled unless `SUBCAST_BUILD_TARGET=desktop` is set.

### Desktop Build

`SUBCAST_BUILD_TARGET=desktop` changes Nuxt output to SPA-compatible behavior:

- `ssr: false`
- `baseURL: './'`

The Electron main process then starts Nitro locally and opens the SPA at `/setup-check`.

### Desktop Runtime

Electron startup flow:

1. Acquire single-instance lock.
2. Clean up orphan sidecars.
3. Check required bundled binaries.
4. Seed bundled Whisper base model if present.
5. Start embedded Nitro or connect to dev server.
6. Inject `x-subcast-token` into local API requests.
7. Create BrowserWindow.
8. Install tray, menu, and updater.

Nitro receives important runtime settings through environment variables:

- `SUBCAST_DESKTOP=true`
- `SUBCAST_API_TOKEN`
- `SUBCAST_HOME`
- `SUBCAST_RESOURCES_PATH`
- `SUBCAST_LLM_BINARY_PATH`
- `SUBCAST_APP_VERSION`

## Data Model

SQLite migrations in `server/utils/db.ts` currently reach `user_version = 12`.

Major tables:

- `videos`
- `subtitles`
- `transcribe_tasks`
- `chunks`
- `translate_tasks`
- `settings`
- `insight_tasks`
- `speakers`
- `diarize_raw_speakers`
- `diarize_tasks`
- `batch_jobs`
- `batch_items`

The application state is split across:

- SQLite task and metadata rows.
- Cache artifacts such as VTT, waveform JSON, insights JSON, and diarization audio.
- Raw media files under the configured videos directory.

This design is pragmatic, but it means data lifecycle changes must update both database rows and filesystem cleanup.

## Queue And Task Model

`server/utils/queue.ts` contains:

- `TranscribeQueue`
- `LLMQueue`
- `TranslateQueueFacade`

The queue design supports:

- One active transcribe task.
- Shared LLM capacity for translation and insights.
- SSE attachment/replay behavior.
- Cancel/resume behavior.
- Shutdown cancellation.
- Crash recovery through boot plugins.

Batch processing in `server/utils/batchRunner.ts` orchestrates existing queues instead of duplicating transcription or translation work. This is the right shape.

Risk: `server/utils/queue.ts` is large and handles several task kinds. Future changes to one queue can accidentally affect the others.

Recommended direction:

- Extract transcribe queue, LLM queue, and shared SSE/task helpers into separate modules.
- Keep the public exports stable while moving internals.
- Convert active LLM task state to a discriminated union, matching the existing TODO.

## Packaging And Native Resources

`electron-builder.config.cjs` is one of the most important files in the repo.

It manages:

- `ffmpeg` and `ffprobe`.
- `whisper-cli`.
- macOS `whisper-libs/*.dylib`.
- `llama-server`.
- bundled Whisper base model.
- Silero VAD model.
- diarization ONNX models.
- native `.node` unpacking.
- macOS rpath and ad-hoc codesign fixes.
- onnxruntime dylib deduplication.
- sherpa-onnx rpath fixes.

Release risk: `binaries/` is gitignored, but it is a release input. A clean Git tree does not prove the release has all required native assets.

Release-critical packaging changes should always include a mounted DMG verification pass.

## Security And Privacy

Strong points:

- Desktop Nitro binds to `127.0.0.1`.
- Desktop APIs require `x-subcast-token` except health checks.
- Token is injected by Electron session request filtering, not exposed to renderer code.
- Preload uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Diagnostic logs are sanitized when debug mode is off.
- Diagnostics avoid media content, transcript text, prompt text, and filenames by default.

Watch areas:

- Any new log field containing path, name, transcript, prompt, or generated text needs explicit privacy review.
- Any new desktop API route should be checked against desktop auth middleware behavior.

## Boundary Findings

Good:

- `app/` has no direct `desktop/` imports.
- `shared/` is runtime-neutral.

Risk:

- `server/` imports `desktop/modelManager/*` in several places.

This coupling is acceptable if the product is considered desktop-first and Nitro is treated as the desktop backend. It becomes a problem if the web/dev app is expected to be deployable as a clean server runtime.

Recommended direction:

- Move pure model catalogs and type-only model IDs into `shared/`.
- Move non-Electron, filesystem-only install helpers into a neutral server-side module if possible.
- Keep Electron-specific path discovery, app APIs, and shell integration in `desktop/`.

## Notable Risks

### P1: Preferred Port Fallback Was Unimplemented

Initial finding: `desktop/nitroEmbed.ts` probed port `51301`. If busy, it set `NITRO_PORT=0`, but the code path for discovering the random port threw.

Impact:

- App could fail startup when another process held `51301`.

Recommendation:

- Allocate an available port explicitly before importing Nitro instead of passing `0`.
- Keep the existing health poll.
- Add a unit test for the occupied preferred-port path.

### P2: Large Queue Module

`server/utils/queue.ts` is a high-change, high-risk module.

Impact:

- Transcribe, translate, insight, cancellation, shutdown, and SSE behavior are tightly colocated.

Recommendation:

- Extract by responsibility while preserving public queue exports.
- Start with shared frame helpers and active task typing.

### P2: Large UI Pages

`player/[hash].vue`, `index.vue`, and `setup-wizard/index.vue` hold a lot of orchestration.

Impact:

- UI feature changes can become harder to review and regression-test.

Recommendation:

- Move operation-specific logic into composables.
- Prefer small presentational components for repeated panels.
- Keep page files as workflow composition surfaces.

### P2: Release Inputs Are Partly Outside Git

`binaries/` resources are necessary for release behavior but mostly untracked.

Impact:

- Builds can succeed while missing important optional or runtime-critical assets.

Recommendation:

- Add or maintain a read-only doctor script for main.
- Fail release verification for required desktop assets.
- Keep release runbook commands up to date.

### P3: Server/Desktop Boundary Debt

`server/` depends on `desktop/modelManager`.

Impact:

- Harder to reason about web runtime portability.

Recommendation:

- Move pure contracts and catalogs to `shared/`.
- Keep desktop-only modules desktop-only.

## Modification Triage

This section revisits each recommendation and marks whether it is worth changing now.

### 1. Fix Nitro Preferred-Port Fallback

Decision: worth modifying now.

Priority: P1.

Evidence:

- The original `desktop/nitroEmbed.ts` implementation explicitly threw when port `51301` was busy and `NITRO_PORT=0` would be needed.
- The original code comment described a random-port fallback, but `guessRandomPort()` was intentionally unimplemented.
- This was a startup reliability issue, not a cosmetic refactor.

Why it is worth doing:

- The scope is small and isolated to desktop startup.
- User impact is high when it triggers: the app fails to launch even though another local port could work.
- The app already passes the final port to the renderer through `SubcastWindowAPI`, so most downstream plumbing is ready.

Recommended change:

- Replace the `port = preferred ?? 0` path with an explicit helper that allocates an available port before importing Nitro.
- Set `NITRO_PORT` to that concrete port.
- Keep the existing health poll.
- Add a focused test around the preferred-port-occupied path if the Electron import boundary can be made testable without heavy mocking.

Implementation note:

- A small race remains whenever a process releases an available port and later binds it again, but this is no worse than the current preferred-port probe and is much better than guaranteed failure.

Status in `codex/main-architecture-analysis`:

- Implemented. `desktop/nitroEmbed.ts` now reserves a concrete loopback fallback port before importing Nitro and no longer uses the unobservable `NITRO_PORT=0` path.

### 2. Add A Main-Branch Doctor Script

Decision: worth modifying soon, preferably after the port fix.

Priority: P2.

Evidence:

- Main has `scripts/verify-mac-artifact.mjs`, but that runs after a macOS artifact exists.
- Main does not have a quick read-only preflight script for boundary checks, native resource presence, package-manager checks, or local `better-sqlite3` ABI.
- Release inputs under `binaries/` are mostly ignored by Git, so ordinary Git status cannot prove release readiness.

Why it is worth doing:

- It is low risk because it can be read-only.
- It would catch common local/release mistakes earlier than a full desktop build.
- The feature branch already demonstrated that this kind of script is useful; main should have a narrower version scoped to main's current features.

Recommended change:

- Add `scripts/subcast-doctor.mjs`.
- Add `package.json` script `subcast:doctor`.
- Check package manager, Node version, `better-sqlite3` ABI, `app/` boundary, `shared/` boundary, required release resources, and electron-builder `extraResources`.
- Keep fixes explicit; the script should report, not mutate.

Status in `codex/main-architecture-analysis`:

- Implemented. `pnpm subcast:doctor` is read-only and currently reports 9 OK, 0 WARN, 0 FAIL on the local machine.

### 3. Extract `server/utils/queue.ts`

Decision: real issue, but defer as standalone work.

Priority: P2 when queue behavior is being changed; otherwise P3.

Evidence:

- `server/utils/queue.ts` is about 1692 lines and contains transcription, translation, insight, cancellation, shutdown, and SSE behavior.
- Existing tests cover key behavior in `queue.test.ts` and `llm-queue.test.ts`.
- The file is complex, but not currently failing.

Why not change immediately:

- Large refactors in queue/state-machine code are easy to make noisier than valuable.
- There is already useful test coverage, so the module is maintainable enough for now.
- A mechanical split without an active behavioral change may create review burden without reducing immediate product risk.

Recommended change:

- Do not do a broad extraction just for cleanliness.
- When touching queue behavior next, first extract shared frame/error helpers and narrow active-task types.
- Convert the active LLM task state to a discriminated union as a small preparatory step.
- Preserve public exports: `transcribeQueue`, `llmQueue`, and `translateQueue`.

### 4. Decompose Large UI Pages

Decision: defer broad decomposition; do opportunistic extraction during feature work.

Priority: P2 when touching player/home/setup flows; otherwise P3.

Evidence:

- `player/[hash].vue`, `index.vue`, and `setup-wizard/index.vue` are large.
- The player already uses composables for subtitle streams, subtitle tracks, subtitle style, subtitle view, video controls, and keybindings.
- Home already uses shared queue and batch composables.

Why not change immediately:

- The codebase has already started extracting behavior, so the problem is not completely unmanaged.
- UI decomposition without a concrete workflow change can easily produce churn and weak verification.
- Player behavior is user-facing and regression-prone.

Recommended change:

- Avoid standalone "split everything" work.
- Extract only while changing a concrete workflow.
- Good next extraction targets are player operation panels, export/diarization command wiring, and upload/batch preparation.
- Keep page components as workflow composition surfaces.

### 5. Release Inputs Outside Git

Decision: worth modifying through the doctor/preflight work, not as a separate packaging rewrite.

Priority: P2.

Evidence:

- `electron-builder.config.cjs` warns and continues when several resources are missing.
- `scripts/verify-mac-artifact.mjs` already validates the final artifact, including important native resources.
- Missing inputs are still easy to miss before a full release build.

Why it is worth doing:

- The risk is release-specific but high impact.
- A read-only preflight catches missing resources earlier.
- The packaging config itself is deliberately permissive for local development, so the stricter behavior belongs in a release check or doctor script.

Recommended change:

- Fold release-input checks into `subcast:doctor`.
- Keep `electron-builder.config.cjs` permissive for developer builds.
- Make release runbook and `release:check:mac` the stricter gate.

Status in `codex/main-architecture-analysis`:

- Implemented through `scripts/subcast-doctor.mjs`. The script checks current-platform sidecar binaries, bundled models, diarization models, tracked binary hygiene, and matching `electron-builder.extraResources` entries.
- Also implemented in `package.json`: desktop build scripts now fetch `llama-server` before packaging, so release builds no longer depend on a pre-existing ignored binary.

### 6. Server/Desktop Boundary Debt

Decision: partially worth modifying, but only in small targeted steps.

Priority: P3 unless a web-deployable server becomes a product goal.

Evidence:

- LLM catalog data has already moved to `shared/llmModels.ts`; `desktop/modelManager/llmConfig.ts` mostly re-exports it.
- Whisper model names are already in `shared/whisperModels.ts`.
- Remaining `server -> desktop/modelManager` imports are a mix of cheap type imports and real desktop install/path/scanning dependencies.

Why not do a broad change now:

- The current product is desktop-first.
- Some remaining imports are genuinely desktop runtime concerns, especially canonical install paths and scan/install behavior.
- Moving everything prematurely could obscure ownership rather than clarify it.

Recommended change:

- Clean up cheap type imports first, such as importing `LlmModelId` directly from `#shared/llmModels` in server code.
- Leave desktop path discovery and install operations in `desktop/modelManager` until there is a clearer server-neutral abstraction.
- If web deployment becomes important, create a neutral `server/modelManager` or `server/modelPaths` layer instead of importing desktop code.

Status in `codex/main-architecture-analysis`:

- Partially implemented. Server code now imports LLM catalog types and pure helpers from `#shared/llmModels`; desktop install, scan, and canonical path helpers remain in `desktop/modelManager`.

## Suggested Work Plan

1. Done: fix Nitro preferred-port fallback.
2. Done: add a main-branch health/doctor script.
3. Done: fold release-input checks into the doctor/preflight path.
4. Done: clean up cheap server imports that can read shared model types/catalogs directly.
5. Defer queue and UI decomposition until the next related feature or bugfix touches those areas.

## Verification Checklist

Quick local checks:

```bash
pnpm test:run
pnpm lint
pnpm typecheck
pnpm build:desktop:main
```

Release-oriented checks:

```bash
pnpm release:check
pnpm build:desktop:mac
pnpm release:verify:mac-artifact
```

Desktop packaging spot checks:

```bash
node - <<'NODE'
const config = require('./electron-builder.config.cjs');
console.log(config.extraResources);
NODE
```

Boundary checks:

```bash
rg -n "desktop/modelManager|\\.\\./\\.\\./desktop" app
rg -n "from ['\\\"]node:|process\\.|\\.\\./server|\\.\\./desktop" shared
```
