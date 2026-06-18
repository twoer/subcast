# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

Subcast is a Nuxt 4 + Electron desktop app for local audio/video transcription, translation, and AI summaries. The same codebase can run as a web dev app, but production distribution is an Electron app with bundled native sidecars.

Key areas:

- `app/` - Nuxt/Vue frontend pages, plugins, and UI utilities.
- `server/` - Nitro API routes, queue, transcription, translation, logging, diagnostics, and tests.
- `desktop/` - Electron main/preload code, menus, updater, diagnostics, binary checks, and model management.
- `shared/` - shared TypeScript utilities and constants.
- `binaries/` - gitignored release assets used by `electron-builder.extraResources`.
- `scripts/` - build/fetch helper scripts.
- `docs/` - packaging, release, smoke-test, and design docs.

## Commands

Use pnpm.

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
```

Desktop:

```bash
pnpm dev:desktop
pnpm dev:desktop:hot
pnpm build:desktop
pnpm build:desktop:mac
pnpm build:desktop:win
```

Targeted tests are usually better while iterating:

```bash
pnpm vitest --run server/utils/__tests__/logSanitize.test.ts
pnpm vitest --run desktop/__tests__/binaryCheck.test.ts
```

## Module Boundaries

- `app/` may import `app/`, `shared/`, Nuxt aliases, UI libraries, and browser-safe packages.
- `app/` must not import `desktop/` or Node/Electron-only modules. Move pure types/catalog data to `shared/` first.
- `shared/` must stay runtime-neutral: no filesystem, Electron, process-specific side effects, or desktop/server imports.
- `desktop/` is for Electron main/preload/menu/updater code and desktop packaging helpers.
- Server/Nitro code may use Node APIs, but reusable Node model-management modules should not be named as Electron-only unless they truly depend on Electron.

Boundary check:

```bash
rg -n "desktop/modelManager|\\.\\./\\.\\./desktop" app
```

Expected: no matches.

## Desktop Packaging Rules

Electron packaging is the fragile part of this repo. Check these files before changing sidecar behavior:

- `electron-builder.config.cjs`
- `desktop/paths.ts`
- `desktop/nitroEmbed.ts`
- `desktop/binaryCheck.ts`
- `server/utils/whisperPaths.ts`
- `server/utils/ffmpegPaths.ts`
- `binaries/README.md`
- `docs/release-runbook.md`

Packaged sidecars live under `Contents/Resources` on macOS. The Nitro server receives this path through `SUBCAST_RESOURCES_PATH`.

Do not assume `node_modules` exists at runtime in a packaged app.

## Whisper Sidecar Notes

The app currently spawns `whisper-cli` from `server/utils/whisper.ts`. On macOS, `whisper-cli` is dynamically linked against `libwhisper` and `libggml*.dylib`.

Important constraints:

- `pnpm build:desktop:mac` runs `pnpm fetch:whisper-cli darwin-arm64`.
- `scripts/fetch-whisper-cli.mjs` stages the local `whisper-cli` build and macOS dylibs into `binaries/darwin-arm64/`.
- `electron-builder.config.cjs` copies `whisper-cli` and `whisper-libs/` into `Contents/Resources`.
- `afterPack` rewrites rpaths to relative loader paths:
  - `whisper-cli` -> `@loader_path/whisper-libs`
  - dylibs -> `@loader_path`
- The packaged app must not depend on paths under `node_modules/nodejs-whisper/.../build`.

Useful verification after building a DMG:

```bash
hdiutil attach -readonly -nobrowse dist-electron/Subcast-0.3.2-arm64.dmg
APP="/Volumes/Subcast 0.3.2/Subcast.app/Contents/Resources"
otool -l "$APP/whisper-cli" | awk '/LC_RPATH/{show=1} show&&/path /{print $2; show=0}'
"$APP/whisper-cli" --help
(otool -l "$APP/whisper-cli"; for f in "$APP"/whisper-libs/*.dylib; do otool -l "$f"; done) | rg '/Users/|node_modules/nodejs-whisper|Documents/Code' || true
hdiutil detach "/Volumes/Subcast 0.3.2"
```

Expected:

- `whisper-cli --help` exits `0`.
- `whisper-cli` rpath is `@loader_path/whisper-libs`.
- each `whisper-libs/*.dylib` rpath is `@loader_path`.
- no absolute build-machine load paths appear in `otool` output.

## Diagnostics And Privacy

Structured logs are written under app user data and exported through diagnostics.

- `server/utils/log.ts` writes JSONL logs.
- `server/utils/logSanitize.ts` redacts paths and names when debug mode is off.
- `server/api/diagnostic.get.ts` builds diagnostic zips.
- `desktop/diagnostics.ts` handles Electron-side export.

When adding new log fields, avoid raw user file paths, filenames, transcript text, prompt text, or model output unless the field is explicitly debug-only and sanitized.

## Git Hygiene

- The working tree may contain user changes. Do not revert unrelated changes.
- `binaries/*/`, `dist-electron/`, `.output/`, `desktop-dist/`, and generated icons are gitignored build artifacts.
- Do not commit packaged apps, model files, native release binaries, or generated build directories.
- Prefer focused commits with tests or verification notes.

## Release Checklist Hints

Before handing a macOS build to testers:

```bash
pnpm build:desktop:mac
```

Then verify the DMG:

- mount the DMG,
- run `whisper-cli --help` from inside the mounted app,
- check `otool` rpaths,
- confirm diagnostics do not leak absolute paths when debug mode is off.

See `docs/release-runbook.md` and `docs/smoke-tests.md` for the broader flow.
