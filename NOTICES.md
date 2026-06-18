# Subcast — Third-Party Notices

This file lists software components Subcast bundles or directly depends
on, together with their authors, license, and obtaining source. It is
provided to satisfy attribution and source-availability obligations of
the licenses below. **Not legal advice — see your local IP counsel for
compliance questions specific to your distribution.**

Subcast itself is licensed under **Apache-2.0**. See `LICENSE`.

---

## 1. Bundled Binaries (shipped inside the .app / installer)

These executables are copied into the distributed application package
via electron-builder's `extraResources`. They live **outside** the asar
archive so end users can replace them — the LGPL components below
require this.

### 1.1 whisper-cli (whisper.cpp)

- **Upstream**: <https://github.com/ggerganov/whisper.cpp>
- **Version**: v1.8.4 (see `.github/workflows/build-whisper.yml`)
- **License**: MIT
- **Copyright**: © 2023 Georgi Gerganov and contributors
- **Source**: cloned at build time by the workflow above; users can
  obtain the same source by checking out the tag from the upstream
  repository.

```
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject
to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### 1.2 ffmpeg / ffprobe

- **Upstream**: <https://ffmpeg.org/>
- **Build**: LGPL build supplied by `@ffmpeg-installer/ffmpeg` and
  `@ffprobe-installer/ffprobe` (npm packages). The LGPL build excludes
  GPL-only encoders such as x264 / x265; only LGPL-licensed components
  are included.
- **License**: LGPL-2.1-or-later (most components) plus permissive
  third-party libraries linked in. The complete license texts ship
  inside each binary's directory upstream.
- **Source**: The corresponding source code for the exact ffmpeg
  version bundled is available from <https://ffmpeg.org/download.html>.
  The npm wrappers (`@ffmpeg-installer/*`, `@ffprobe-installer/*`)
  document which upstream snapshot they ship.
- **Replacing the bundled binary**: users may substitute their own
  ffmpeg / ffprobe by replacing the files at
  `<App>/Contents/Resources/ffmpeg` (macOS) or `resources/ffmpeg.exe`
  (Windows). This freedom is part of LGPL compliance — Subcast does
  not statically link or otherwise prevent replacement.

> **Note on patents**: ffmpeg includes implementations of audio/video
> codecs (e.g. H.264, HEVC, AAC) that may be covered by patents in some
> jurisdictions. Subcast distributes ffmpeg under LGPL but makes no
> warranty about patent rights in any specific country. End users and
> downstream redistributors are responsible for any required patent
> licensing.

---

## 2. AI Models

Subcast does **not** bundle AI model weights. They are downloaded by
the user at first run or installed separately:

### 2.1 Whisper models (ggml format)

- **Source**: <https://huggingface.co/ggerganov/whisper.cpp>
- **License**: MIT (per upstream model card)
- **Distribution**: fetched on-demand by the in-app setup wizard /
  `nodejs-whisper`; never redistributed by Subcast.

### 2.2 Ollama models (Qwen, Llama, Mistral, ...)

- **Source**: <https://ollama.com/library>
- **License**: Varies per model. The user is responsible for accepting
  each model's individual license when pulling it via `ollama pull`.
  Common ones: Qwen / Mistral / Phi → Apache-2.0; Llama 3 → Llama 3
  Community License.
- **Distribution**: Subcast never redistributes Ollama models; it
  invokes the locally-installed `ollama` binary which the user has
  separately installed from <https://ollama.com>.

---

## 3. Runtime Dependencies (Node / npm)

Listed by license. Full per-package texts live inside each module's
own `LICENSE` file under `node_modules/<pkg>/`. The lockfile
(`pnpm-lock.yaml`) pins exact versions; consult it for the canonical
list at any commit.

### MIT-licensed (majority)

`@nuxtjs/i18n`, `better-sqlite3`, `bindings`, `electron`,
`electron-updater`, `electron-window-state`, `h3`, `jszip`, `nuxt`,
`vue`, `vue-router`, `tailwind-merge`, `class-variance-authority`,
`clsx`, `archiver`, `nodejs-whisper`, `check-disk-space`,
`reka-ui`, `shadcn-nuxt`, `tailwindcss-animate`, and others.

### Apache-2.0

`sharp`, `typescript`, `lucide-vue-next` (ISC variant of permissive
license), `class-variance-authority`. The Apache 2.0 patent grant is
included verbatim in each package's distribution.

### ISC

`lucide-vue-next`. Functionally equivalent to MIT for our usage.

### LGPL-2.1

`@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe` — these are
the npm wrappers around the LGPL binaries discussed in §1.2 above. The
wrapper code itself is LGPL-2.1; we use it as a library rather than
linking, so the standard LGPL compliance terms apply.

### Other

- `jszip` — dual MIT / GPL-3.0; we elect MIT.

---

## 4. Privacy / Data Practices

Subcast is a **local-first** application:

- No analytics, telemetry, or remote-error reporting.
- No outbound network connections at runtime, except as initiated by
  the user (e.g., downloading a Whisper model from HuggingFace via the
  setup wizard, or talking to a user-installed local Ollama at
  `http://localhost:11434`).
- Logs (`~/.subcast/logs/*.jsonl`) are written locally only and never
  transmitted. File paths and names are hashed at log time unless the
  user has explicitly enabled Debug Mode in Settings.
- The "Export Diagnostics" action produces a ZIP on the user's local
  disk; nothing is uploaded.

This design choice means Subcast does not, by its own behaviour,
process personal data in a way that triggers GDPR / PIPL data-controller
obligations. Bundled binaries (ffmpeg, whisper-cli) operate only on
files the user explicitly provides.

---

## 5. Reporting an Issue

License-related questions, attribution corrections, or notices of
infringement: <https://github.com/twoer/subcast/issues>.
