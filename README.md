# Subcast

> Free · Offline · LLM-powered — audio/video transcription + translation
>
> 中文文档: [README.zh.md](./README.zh.md)

> ⚠️ **First-time setup requires internet.** Once Whisper, Ollama, and Qwen
> models are downloaded, all transcription and translation runs
> **100% locally** — no cloud APIs, no telemetry, no recurring costs.

Drop in a video → local Whisper transcribes → translate on demand while
you watch. Subcast ships as a desktop app on macOS and Windows; the same
codebase also runs as a regular Nuxt web app for developers.

## Highlights

- 🔒 **Privacy-first** — all inference runs locally
- 💸 **Zero ongoing cost** — no cloud APIs
- 🌍 **Multilingual** — original + any target language, switchable on the fly
- ⚡ **Streaming** — start watching while transcription is still running
- ↩️ **Resume on crash** — interrupted transcription continues from the last completed 30-second chunk
- 🚦 **Adaptive setup** — first-run wizard picks Whisper / Ollama models based on your hardware and reuses any models already on disk
- 📥 **Export & search** — VTT / SRT / TXT (mono- and bilingual; bulk → ZIP); in-player search with highlighted matches
- ✨ **AI summary + chapters** — one-click via local Ollama; chapters click to seek

---

## Install (desktop)

<!-- TODO(v0.1.0): replace the placeholder hero with a screenshot of the
     setup-wizard's Step 1 (model picker with "Recommended" badge). -->

### Download

Grab the latest installer from the
[Releases page](https://github.com/twoer/subcast/releases):

| Platform        | File                                  | Size (~) |
|-----------------|---------------------------------------|----------|
| macOS (Apple Silicon) | `Subcast-<version>-arm64.dmg`   | 260 MB |
| Windows (x64)   | `Subcast-Setup-<version>.exe`         | 240 MB |

The Whisper / Ollama / Qwen models themselves are downloaded by the
first-run wizard, not bundled. Expect another **~5 GB** (recommended
tier: `base` + `qwen2.5:7b`).

### macOS

1. Double-click the `.dmg` and drag **Subcast** into Applications.
2. The first launch shows a Gatekeeper warning (Subcast is unsigned by
   choice — see *License & cost* below). Handle it once:

   - **macOS 14 (Sonoma) and earlier** — Right-click `Subcast.app` in
     Applications → **Open** → confirm.
   - **macOS 15+ (Sequoia)** — System Settings → **Privacy & Security**
     → scroll down to *"Subcast was blocked"* → **Open Anyway**, then
     authenticate.

   <!-- TODO(v0.1.0): two screenshots, side-by-side, one per OS version. -->

3. The setup wizard guides you through:
   1. **Whisper transcription model** — pick a tier (default `base`).
      If you already have a `ggml-*.bin` file on disk (e.g. from
      [whisper.cpp](https://github.com/ggerganov/whisper.cpp) or
      [Aiko](https://sindresorhus.com/aiko)), Subcast offers to symlink
      or copy it instead of downloading.
   2. **Ollama runtime** — installs to its own location and runs as a
      menu-bar app. Subcast detects it automatically; if it isn't
      running, click *"Open ollama.com"* and re-check once installed.
   3. **Qwen language model** — choose `3b` / `7b` (recommended) / `14b`.
      Already-installed variants are pre-selected with a ✓.

4. Done. Drag a video into the window or use **File → Open** (right-click
   `.mp4`/`.mkv`/`.mov`/`.webm`/`.mp3`/`.wav`/`.m4a` in Finder → "Open
   With → Subcast" once the file association is registered).

### Windows

1. Run `Subcast-Setup-<version>.exe`. SmartScreen will say
   *"Windows protected your PC"* because Subcast uses a self-signed
   certificate (see *License & cost*).

   - Click **More info** → confirm the publisher is **Subcast (twoer)**
     → **Run anyway**.

   <!-- TODO(v0.1.0): SmartScreen warning screenshot. -->

2. Pick an install location (per-user, default
   `%LOCALAPPDATA%\Programs\Subcast`).
3. Follow the same three-step setup wizard as macOS.
4. The installer adds **Subcast** to the Start menu and registers an
   optional "Open With" entry for the media extensions above.

User data lives at `%APPDATA%\Subcast` on Windows or
`~/Library/Application Support/Subcast` on macOS — models, cached
transcripts, and logs all go there. Subcast never writes outside its
data folder.

---

## Day-to-day usage

### Tray / menu-bar icon

Closing the main window hides it; background work (transcription,
translation, AI insights) keeps running. The tray menu re-opens the
window, runs *Export Diagnostics…*, *Check for Updates…*, or quits.

`Cmd+Q` / `Ctrl+Q` (or "Quit" from the tray) does a real shutdown — any
in-flight tasks are cancelled cleanly and resume from the last completed
chunk on next launch.

### Keyboard shortcuts (player)

| Key | Action |
|---|---|
| Space / K | Play / pause |
| ← / → | Seek ±5 s |
| J / L | Seek ±10 s (YouTube-style) |
| ↑ / ↓ | Volume ±10 % |
| < / > | Speed ±1 step |
| M / F / C | Mute / fullscreen / toggle subtitles |
| 1–9 | Jump to 10–90 % of the video |
| ? | Show shortcut help |
| Esc | Close any dialog |

---

## Troubleshooting

### Export Diagnostics

If something misbehaves, **Help → Export Diagnostics…** (also in the tray
menu) zips the last 7 days of structured logs plus a `system.json`
snapshot (OS, app version, hardware basics). No video content, transcript
text, or filenames are included. Attach the zip when filing an issue.

### Common issues

| Symptom | Fix |
|---|---|
| Wizard says "Ollama not detected" but you installed it | Ollama runs as a separate menu-bar / system-tray app. Click its icon, confirm it's "running", then click *"I've installed it"* in the wizard. |
| Download stuck at 0% on Whisper model | China-mainland users: tick *"Use hf-mirror.com"* in the wizard. The bytes already on disk will resume from the mirror — no restart needed. |
| Cmd-clicking the app on macOS 15+ still does nothing | Open *System Settings → Privacy & Security*, scroll to the bottom for the explicit *"Open Anyway"* button (the Open-with-Open menu was deprecated in this OS). |
| Transcription stopped mid-video | Just relaunch. Transcribe tasks resume from the last completed 30 s chunk. Translation tasks are marked *failed* with a retry button on the home page — we don't silently re-spend Ollama tokens. |

---

## Updates

- **Windows** — Subcast auto-downloads differential updates from GitHub
  Releases in the background and installs them on next launch. Updates
  are signed with the same self-signed certificate as the installer.
- **macOS** — Manual: **Help → Check for Updates…** (also fires
  silently 5 seconds after launch when a new version is available). It
  opens the release page in your browser; download and drag-replace the
  app in Applications.

---

## Developers — run from source

```bash
git clone https://github.com/twoer/subcast.git
cd subcast
pnpm install
pnpm dev          # http://localhost:3000
```

Dev mode is a normal Nuxt 4 server — no Electron, no `userData`. Hardware,
Ollama, Whisper requirements are listed in
[README.zh.md](./README.zh.md). Tests:

```bash
pnpm test         # vitest --run
pnpm typecheck
pnpm lint
```

Desktop build (produces `.dmg` / `.exe` in `dist-electron/`):

```bash
pnpm build:desktop          # current platform
pnpm build:desktop:mac      # macOS arm64 only
pnpm build:desktop:win      # Windows x64 only
```

### Design docs

- [`docs/desktop-packaging.md`](./docs/desktop-packaging.md) — desktop
  architecture and ~36 design decisions
- [`docs/desktop-execution-plan.md`](./docs/desktop-execution-plan.md) —
  file-by-file Phase 0 through Phase 5 task list
- [`docs/windows-codesigning.md`](./docs/windows-codesigning.md) —
  self-signed certificate runbook

---

## License & cost

[AGPL-3.0-or-later](./LICENSE) © 2026 twoer

Subcast is licensed under AGPL v3. Forks and network-service derivatives
must be released under AGPL v3 with source available.

Third-party components (whisper-cli MIT, ffmpeg LGPL build, all npm
dependencies) and their attribution / source-availability notices are
listed in [`NOTICES.md`](./NOTICES.md). ffmpeg source corresponding to
the bundled LGPL build is available from <https://ffmpeg.org/download.html>.

By design, **shipping Subcast costs the maintainer $0/year**:

- macOS: not enrolled in the Apple Developer Program ($99/yr). Users
  see a Gatekeeper warning the first time and dismiss it once.
- Windows: self-signed code-signing certificate ($0). Users see a
  SmartScreen warning the first time and dismiss it once via
  *"More info → Run anyway"*.
- Distribution: GitHub Releases (free for public repos).
- Telemetry / crash reporting: none — diagnostics ship by user action only.

For users who want zero install friction, the upgrade path is a paid
OV code-signing cert (~$200/yr) and Apple Developer enrollment ($99/yr)
— neither is on the v0.1.0 roadmap.
