# Subcast smoke-test checklist (Phase 5.3)

Run this list against a fresh `.dmg` / `.exe` before publishing each
release. Every step is a manual user-flow check — automation is not in
scope for v0.1.0. Copy the relevant section into the release issue and
mark items as you go.

> **Reset state between runs**: remove the app **and** its user-data
> directory (`~/Library/Application Support/Subcast` on macOS,
> `%APPDATA%\Subcast` on Windows). The setup wizard's "earliest unmet
> step" logic will skip steps if you forget.

---

## 1. macOS arm64 happy path

Hardware: Apple Silicon · macOS 14 or 15+ · ≥ 8 GB RAM · ≥ 10 GB free.

- [ ] Mount the `.dmg`; drag **Subcast** to Applications
- [ ] First launch shows the Gatekeeper dialog
  - [ ] macOS 14: right-click → Open → Open confirms
  - [ ] macOS 15+: System Settings → Privacy & Security → "Open Anyway"
- [ ] Window opens, dark theme renders immediately (no white flash)
- [ ] `/setup-check` redirects to `/setup-wizard` Step 1
- [ ] **Step 1 (Whisper)**: pick `base` → Download → progress bar advances → completes → ✓ Found at `<userData>/models/whisper/ggml-base.bin`
- [ ] **Step 2 (Ollama)**: shows correct tristate (running / installed-not-running / needs-install). If `needs-install`, click *Open ollama.com*, install, click *I've installed it*, confirm tristate flips
- [ ] **Step 3 (Qwen)**: pick `7b` → Pull → NDJSON progress lines flow → ✓ qwen2.5:7b is ready
- [ ] Finish → home page; setup-incomplete banner is **not** shown
- [ ] Drag a `.mp4` (~ 2 min) into the home page upload zone
- [ ] Transcription progresses; first cue appears within ~5 s (base model)
- [ ] Switch language → translation streams in
- [ ] AI Insights → summary + chapters render; chapter click seeks the player
- [ ] Export → SRT / VTT / TXT / bilingual all download

---

## 2. Windows x64 happy path

Hardware: Windows 11 23H2 or 24H2 · ≥ 8 GB RAM · ≥ 10 GB free.

- [ ] Run `Subcast-Setup-<version>.exe`; SmartScreen says "Windows protected your PC"
  - [ ] Click *More info* → publisher reads **Subcast (twoer)** → *Run anyway*
- [ ] NSIS picks per-user install location; finish wizard
- [ ] Launcher starts Subcast; same Step 1 / 2 / 3 setup-wizard flow as macOS
- [ ] Right-click a `.mp4` in Explorer → *Open With → Subcast* — file lands in the player
- [ ] Translation + AI Insights + Export all behave as on macOS

---

## 3. Model-reuse scan (decision 34)

Pre-condition: `~/.subcast/.../models/ggml-base.bin` exists from a prior
web-mode session, OR `~/whisper.cpp/models/ggml-base.bin` from a manual
build.

- [ ] Setup wizard Step 1: selecting `base` shows the green "Found
      existing file at …" line with the correct path + source label
- [ ] **Symlink** branch: completes instantly; the canonical model dir
      contains a symlink pointing at the original
- [ ] **Copy** branch: completes; the canonical model dir contains a
      regular file with a fresh inode
- [ ] **Ignore** branch: falls back to download; the original is
      untouched

---

## 4. Qwen already-installed detection (decision 35)

Pre-condition: `ollama pull qwen2.5:14b` already ran successfully.

- [ ] Setup wizard Step 3 shows `qwen2.5:14b` ✓ already installed
- [ ] Default selection is `14b` (largest installed wins)
- [ ] Hitting *Finish* without a pull works — no Ollama API hit
- [ ] Switching to `7b` and clicking *Pull* starts a real download

---

## 5. Disk-space precheck (decision 22)

Pre-condition: artificially shrink free space on the target volume
(macOS: `mkfile -n 20g /tmp/fill`; Windows: large dummy file via
PowerShell).

- [ ] Whisper Step 1 with `medium` selected → "Download" disabled,
      error banner says "Need 2.4 GB free, only X available"
- [ ] Remove the dummy file → re-check → the banner clears

---

## 6. Network interruption + resume

- [ ] Start downloading `medium` (1.5 GB) over slow / throttled network
- [ ] Pull the cable / disable Wi-Fi mid-download
- [ ] Re-enable network → resume retries Range request; bytes resume
      from where they stopped (no re-download)
- [ ] Tamper the file on disk (e.g. truncate to half) → re-trigger →
      hash mismatch → retry from scratch (one retry)

---

## 7. Single-instance lock

- [ ] Launch Subcast; before splash hides, double-click the dock /
      taskbar icon again
- [ ] Second launch is suppressed; existing window comes to front
- [ ] If a file path is associated with the second launch (right-click
      `.mp4` → Subcast), the path is forwarded to the existing window
      and triggers upload-from-path

---

## 8. Startup failure dialog

- [ ] Pre-occupy port 51301 (`nc -lk 51301` or similar) **and** make
      the userData dir read-only to force a hard Nitro failure
- [ ] Launch Subcast → friendly error dialog appears with three buttons
- [ ] *Open Log Folder* → file manager opens `<userData>/logs`
- [ ] *Report Issue…* → browser opens GitHub new-issue with
      version / platform / arch / error pre-filled in the body
- [ ] *Quit* → process exits cleanly (no lingering Electron processes
      in Activity Monitor / Task Manager)

---

## 9. Tray + hide-on-close

- [ ] Click window close button → window hides, tray icon stays
- [ ] Background transcription continues (verify with queue still
      progressing)
- [ ] Tray click reveals window in the same state
- [ ] Cmd+Q / Ctrl+Q / tray Quit → real exit; in-flight rows landed
      as `canceled` in the DB (not zombie `running`)

---

## 10. Startup recovery

- [ ] Kick off a long transcription, force-kill the Electron process
      (Activity Monitor / Task Manager → End Task)
- [ ] Relaunch → transcribe task resumes from the last completed
      30-second chunk (zero new bytes wasted)
- [ ] Repeat with translation in flight → translation lands as
      `failed` with `error_msg = "Interrupted by app exit"`; home page
      offers a retry button

---

## 11. Uninstall

- [ ] **macOS**: drag `Subcast.app` to Trash → user data folder
      still present at `~/Library/Application Support/Subcast`
- [ ] **Windows**: Settings → Apps → Uninstall → NSIS dialog asks
      *"Also remove your Subcast data folder?"* with default **No**
  - [ ] Choosing No: `%APPDATA%\Subcast` survives
  - [ ] Choosing Yes: `%APPDATA%\Subcast` is gone after uninstall completes

---

## 12. Auto-update (post-v0.1.1)

Defer until v0.1.1 ships — needs two consecutive releases to verify.

- [ ] **Windows**: install v0.1.0, ship v0.1.1, relaunch v0.1.0,
      confirm differential downloads silently, next launch is v0.1.1
- [ ] **macOS**: install v0.1.0, ship v0.1.1, Help → Check for
      Updates… opens the release page; manual replace works

---

## LLM 切换 (0.2)
- [ ] `node scripts/reset-for-first-run.mjs` → setup wizard step 2 displays the three Qwen tiers
- [ ] Hardware tier recommendation matches RAM (16GB Mac shows 7B as recommended)
- [ ] LM Studio Qwen 7B installed → scanned + symlink option offered → symlink succeeds
- [ ] Default hf-mirror.com download of 3B model completes
- [ ] Skip wizard step 2 → main UI AI buttons greyed + AppHeader chip shows amber dot
- [ ] After transcription → click AI Insights → first request takes ~3s (model load) → subsequent are instant
- [ ] No AI activity for 5 minutes → llama-server auto-stops (verify via Activity Monitor: RAM drops)
- [ ] Next AI request after auto-stop spawns server fresh
- [ ] Settings → switch active model to 14B → old server stops, new model loads on next request
- [ ] Settings → delete active model → API returns 409
- [ ] Settings → delete non-active model → succeeds
- [ ] Cmd+Q → llama-server process disappears within 5s (verify `ps aux | grep llama-server`)
- [ ] `kill -9 <subcast pid>` while running → next Subcast launch cleans up orphan llama-server

---

## Sign-off

- [ ] All applicable sections passed
- [ ] Exported diagnostics zip reviewed (no PII, no transcript text)
- [ ] Performance baseline recorded in `docs/performance-baseline.md`
- [ ] Ready for `git tag v<version>`
