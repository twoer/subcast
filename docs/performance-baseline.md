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

### v0.5.0 — 2026-08-16（模型调用链路专项）

> 范围:本块只记录模型调用链路的实测（生产日志推导 + 同机 A/B），完整六项基线未测。

环境:M3 Pro(12 核)· macOS · large-v3-turbo(ASR)+ Qwen3-8B Q4_K_M(LLM)· 生产日志(`.dev-userdata/logs/2026-08-16.jsonl`)与同机 A/B。

| 指标 | 数值 | 说明 |
|------|------|------|
| whisper 每 chunk(常驻 server,生产) | **2.0s** / 30s chunk | 27 chunks / 54s,批量导入 4 视频期间 |
| whisper 每 chunk(whisper-cli spawn,同机基线) | 2.75s(轻载)– 4.9s(重载) | 同一切片 A/B + 生产日志 spawn durationMs |
| 提速幅度 | **25–60%**(负载越高越大) | spawn+模型加载成本消除 |
| SenseVoice(常驻 worker) | ~0.24s / 10s chunk | 29 chunks / 7s |
| chunk 间循环开销(切片+DB+SSE) | p50 = **7ms** | P2.1 内存切片后;P2.2 流水线由此关闭 |
| 润色批次(Qwen3-8B,25 条/批) | 8–10s | LLM 队列串行,json_schema 约束零 mismatch |
| llama-server 冷启动 | 0.76–1.5s(热页缓存)/ ~20s(冷盘) | 转写尾段预热对冲 |
| whisper-server 冷启动 | 0.76–1.5s(热) / ~20s(1.6GB 冷盘) | 任务前预热对冲 |

遗留观察:批量导入时 LLM 队列单并发为瓶颈(4 个润色任务串行排空)——P4(`--parallel 2`)的依据,见 `docs/plans/2026-08-16-model-invocation-efficiency.md` 待办。

### v0.5.1 post-release checkpoint — 2026-08-17

> Scope: post-release stability gate for the llama.cpp/Qwen3 model-control baseline. Automated checks, macOS artifact verification, and API-level real-media smoke were run in this session.

Environment: MacBook Pro · Apple M3 Pro · 36 GB RAM · macOS arm64.

| Check | Result | Notes |
|-------|--------|-------|
| `pnpm test` | PASS | 83 files passed, 2 smoke files skipped; 597 passed / 2 skipped |
| `pnpm lint` | PASS with known warnings | 2 website warnings in `website/.vitepress/theme/components/HomeCompare.vue` |
| `pnpm typecheck` | PASS with known warnings | Nuxt duplicated `SpawnResult` import warning; Vue/Volar `vue-router/volar/sfc-route-blocks` export warning |
| `pnpm build:desktop:mac` | PASS | Built `dist-electron/Subcast-0.5.1-arm64.dmg` |
| `node scripts/verify-mac-artifact.mjs` | PASS after verifier alignment | rpaths and sidecars verified; verifier now matches afterPack's `/Users/runner/work/` upstream llama.cpp debug-string exemption |

| Runtime item | Value | Notes |
|--------------|-------|-------|
| LLM model | Qwen3-8B-Q4_K_M | Real translate, polish, and Insight smoke passed through `llama-server` |
| Runtime profile | `macos-metal-standard` | `parallelSlots=2`, `perSlotContext=8192`, `gpuBackend=metal`, warning: `metal_unverified` |
| Short-file timing | 3.2s media: transcribe 0.7s, translate 6.0s, polish 2.0s, Insight 10.8s | `sample-3s.mp3`, 1 cue, English Insight |
| Multi-chunk timing | 59s media: transcribe 2.1s, translate 24.3s, polish 16.9s, Insight 23.5s | `0413_59s.mp3`, 7 SenseVoice chunks/cues, English Insight |
| Diagnostics export | PASS privacy scan | `debugMode=false`; no matches for local paths, source test directory, prompt text, transcript snippets, or Insight output snippets |
| Artifact cache switch check | PASS with caveat | Re-request reused matching 8b fingerprinted artifact; switching setting to uninstalled 4b did not reuse 8b artifact and surfaced `MODEL_NOT_CONFIGURED` |
| User-visible issues | Two fixed during smoke/review | Missing-model SSE error exposed sidecar stderr/path-like text; fixed by sanitizing user-visible LLM task errors and mapping model-load failures to `MODEL_NOT_CONFIGURED`. Final review also fixed `/api/queue/list` Insight rows so structured `errorCode` reaches the UI. |

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
