# Subcast performance baseline (Phase 5.4)

A pre-release sanity check, not a continuous benchmark. Record numbers
here for every v0.x.y so regressions show up obviously in the next
release. Targets are the floor; under is fine, over needs investigation
before shipping.

## Targets

| # | Metric | Target | Notes |
|---|--------|--------|-------|
| 1 | Cold launch → main window interactive | < 3 s | M1 / 8 GB / SSD baseline |
| 2 | Steady-state main process RSS | < 300 MB | Idle, no transcription in flight |
| 3 | First cue rendered after *Start transcription* | < 5 s | `base` Whisper model |
| 4 | Setup wizard "Open ollama.com" → return → detected | < 30 s | Ollama install time excluded |
| 5 | Diagnostics zip end-to-end | < 5 s | Last-7-day logs (typical ~20 MB raw) |
| 6 | Tray click → window visible | < 200 ms | Window already hidden, not closed |

How to measure each metric is documented in `## Recipes` below.

## Measurements

Fill one block per measured build. Append, don't overwrite.

### v0.1.0 — TBD

> Drop this section when measuring; copy lines into the release issue.

| Metric | macOS arm64 | Windows x64 | Notes |
|--------|-------------|-------------|-------|
| Cold launch interactive | — s | — s | Hardware: macOS M1 8GB / Win 11 i5 16GB |
| Steady-state RSS | — MB | — MB | After 60 s idle |
| First cue (base) | — s | — s | 60-second test clip |
| Wizard Ollama loop | — s | — s | Bench excludes manual install |
| Diagnostics export | — s | — s | 7-day log dir |
| Tray-show latency | — ms | — ms | Eyeballed via screen recording |

Any reds → investigate before publishing the tag. If a regression is
intentional (e.g. new feature traded for slower launch), document the
trade in the release notes.

---

## Recipes

### 1. Cold launch interactive

Cold = process not in memory; userData fresh enough that the setup-check
endpoint returns "ready". For a not-fresh launch (more realistic), use a
fully-configured userData.

- **macOS**: `killall Subcast` → `time open /Applications/Subcast.app`
  (or stopwatch the GUI). Stop the clock the moment the main window
  responds to mouse-over events.
- **Windows**: `Stop-Process -Name Subcast -Force` → launch via Start
  menu → stopwatch.

### 2. Steady-state RSS

- **macOS**: `ps -o rss= -p $(pgrep -i '^Subcast Helper$' | head -1)` or
  Activity Monitor → Subcast main process → Real Mem. Sample after the
  app sits idle for 60 s with no queue work.
- **Windows**: Task Manager → Details → `Subcast.exe` (main process) →
  Memory column. Sample after 60 s idle.

### 3. First cue latency (base model)

Use the same short test clip across runs (60-second commit it as
`demo/test-clip.mp4` once and reuse).

- Drop the clip onto the home page upload zone
- Start a stopwatch when the upload finishes (visible by URL flipping to
  `/player/<hash>`)
- Stop when the first `cue` element shows up in the right-side list
- Repeat 3×, record the median

### 4. Wizard Ollama loop

- Uninstall Ollama between runs (`rm -rf /Applications/Ollama.app` on
  macOS).
- Stopwatch from clicking "Open ollama.com" → finishing the Ollama
  installer → clicking "I've installed it" → wizard advances. Subtract
  the manual install time (separately measured) to isolate Subcast's
  contribution.

### 5. Diagnostics export

- Help → Export Diagnostics… → time from click to "saved" dialog.
- Ensure `<userData>/logs` has at least 5 day-files, ≥ 5 MB each.

### 6. Tray-show latency

- Screen-record at ≥ 60 fps while clicking the tray icon
- Frame-count from click animation to first window content frame
- Convert to ms

---

## Known regressions / fixes

> Reverse-chronological. Cite the commit that landed the change.

- *(empty until first regression is found)*

---

## Why not Sentry / OpenTelemetry?

Decision 8 — Subcast ships zero telemetry. Every number above is
measured locally by the maintainer at release time; users never send
anything home. If the maintenance burden gets too high, an opt-in
diagnostics mode is the natural next step, not a default-on collector.
