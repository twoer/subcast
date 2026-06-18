# binaries/

CI-built native binaries + bundled model blobs referenced by
electron-builder's `extraResources`. All gitignored — never committed.

Contents:
- `darwin-arm64/whisper-cli`   — whisper.cpp `v1.8.4` Metal-enabled
- `darwin-arm64/whisper-libs/` — libwhisper + libggml dylibs required by
  the macOS `whisper-cli`
- `win32-x64/whisper-cli.exe`  — whisper.cpp `v1.8.4` CPU-only
- `models/ggml-base.bin`       — default Whisper model (~148 MB) shipped
  in the DMG so first launch is offline-usable. Symlinked into
  `<userData>/models/whisper/` by Electron main on startup (see
  `desktop/modelManager/seedBundledModel.ts`).

Fetch helpers (run before `pnpm build:desktop:*`):
- `scripts/fetch-whisper-cli.mjs` — stage local whisper-cli and macOS dylibs
- `scripts/fetch-ggml-base.mjs`   — ggml-base.bin (mirror via
  `SUBCAST_HF_MIRROR=hf-mirror`)
- `scripts/fetch-llama-server.mjs` — llama-server binary (mirror:
  Subcast-binaries Releases)

Sources of truth:
- whisper-cli: `.github/workflows/build-whisper.yml` — bump
  `WHISPER_CPP_VERSION` there → re-trigger → re-fetch.
- ggml-base.bin: `huggingface.co/ggerganov/whisper.cpp` (HF mirror
  `hf-mirror.com` for restricted networks).
