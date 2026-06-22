# Changelog

## 0.4.8 — 2026-06-22

### 修复 / Fixed
- 0.4.6 和 0.4.7 的 `--retry-sleep` 参数语法都写错了，导致 yt-dlp 拒绝整个命令行、URL 导入对所有链接立即失败。按 yt-dlp 自带 `--help` 的实际语法（`[TYPE:]EXPR`，EXPR 是 `exp=START:END` 而非单词 `exponential`）改为 `--retry-sleep http:exp=1:20`，已在本地用打包的 yt-dlp 2026.06.09 实测通过
  The `--retry-sleep` argument shipped in 0.4.6 (`http:5,exponential`) and 0.4.7 (`http:exponential`) used invalid syntax, so yt-dlp rejected the whole argv and URL import failed instantly for every link. Changed to `--retry-sleep http:exp=1:20` per yt-dlp's own --help format (`[TYPE:]EXPR`, EXPR is `exp=START:END` not the word "exponential"), verified locally against the bundled yt-dlp 2026.06.09

## 0.4.7 — 2026-06-22

### 修复 / Fixed
- 0.4.6 的 URL 导入对任何链接都立即失败：`--retry-sleep http:5,exponential` 是无效语法（yt-dlp 的每个重试类型只接受一个表达式，不能把固定值和模式用逗号组合），yt-dlp 报 `invalid http retry sleep expression` 后直接退出。改为 `--retry-sleep http:exponential`（1s→2s→4s…）
  URL import in 0.4.6 failed instantly for every link: `--retry-sleep http:5,exponential` is invalid syntax (yt-dlp accepts a single expression per retry type — a fixed delay and a mode can't be combined with a comma), and yt-dlp exited with `invalid http retry sleep expression`. Changed to `--retry-sleep http:exponential` (1s→2s→4s…)
- yt-dlp 报错时日志和错误条把整段 `Usage: yt-dlp [OPTIONS]...` 帮助文本也塞进了 message，可读性差：新增 `extractYtDlpError` 提取 `yt-dlp: error:` / `ERROR:` / `error:` 标记行，丢弃 usage banner
  When yt-dlp errored, the log and error banner inlined the entire `Usage: yt-dlp [OPTIONS]...` help text into the message, hurting readability: added `extractYtDlpError` to pull out the `yt-dlp: error:` / `ERROR:` / `error:` marker line and drop the usage banner

## 0.4.6 — 2026-06-22

### 修复 / Fixed
- URL 导入的取消按钮形同虚设：点击只关闭了前端进度条，服务端 yt-dlp 仍在后台下载，浪费带宽和磁盘。新增 `DELETE /api/import-url` 接口，前端保留 jobId 并真正调用，取消时 SIGTERM 掉运行中的 yt-dlp 或丢弃排队任务
  The URL import cancel button was decorative: clicking it only closed the frontend progress bar while the server-side yt-dlp kept downloading in the background. Added a `DELETE /api/import-url` endpoint; the frontend now retains the jobId and actually calls it, SIGTERM'ing the running yt-dlp or dropping the queued task on cancel
- 并发导入两个链接会各自启动 yt-dlp，破坏「一次只跑一个」契约：队列执行槽现在在第一个 `await` 之前就被同步占用，两次并发的 `ensureTask()` 只有一个能 spawn 进程
  Two concurrent imports could each spawn yt-dlp, breaking the one-at-a-time contract: the queue's execution slot is now reserved synchronously before the first `await`, so only one of two concurrent `ensureTask()` calls gets to spawn a process
- 取消在「槽位已预占但 yt-dlp 还没 spawn」的窗口内仍会失效：`runTaskInner` 现在在每个 `await` 之后重新检查 `task.phase`，cancel 在此窗口到达时不会继续 spawn
  Cancel still failed in the window between slot reservation and yt-dlp spawn: `runTaskInner` now re-checks `task.phase` after each `await`, so a cancel arriving in that window no longer proceeds to spawn
- URL 导入的媒体一律存成 `.mp4`，导致音频被以错误 Content-Type 提供并破坏播放器：现在按下载文件的真实扩展名（`.m4a`/`.webm`/`.mp3` 等）落盘并入库
  URL-imported media was always stored as `.mp4`, so audio was served with the wrong Content-Type and broke the player: files are now persisted under their real extension (`.m4a`/`.webm`/`.mp3` etc.) as produced by yt-dlp
- URL 导入没有大小上限，本地 2GB 上限可被绕过：yt-dlp 加 `--max-filesize 2G`，落盘后再做 `statSync` 二次校验
  URL import had no size cap, allowing the local 2GB ceiling to be bypassed: yt-dlp now gets `--max-filesize 2G`, plus a post-download `statSync` re-check
- 链接 slug 已带扩展名时原文件名出现 `video.mp3.mp3`：`buildOriginalName` 在拼接真实扩展名前先剥掉已知媒体后缀
  When the URL slug already carried an extension, the original name came out as `video.mp3.mp3`: `buildOriginalName` now strips a known media suffix before appending the real extension
- 部分 CDN（IPv6 路径）下载报 `SSL: UNEXPECTED_EOF_WHILE_READING`、10 次重试全失败：yt-dlp 加 `--force-ipv4` 绕开 IPv6 路径，并加 `--retry-sleep http:5,exponential` 退避重试避免被 CDN 限流加重
  Some CDNs (IPv6 path) failed with `SSL: UNEXPECTED_EOF_WHILE_READING` and exhausted all 10 retries: yt-dlp now pins IPv4 with `--force-ipv4` to avoid the flaky IPv6 route, and backs off with `--retry-sleep http:5,exponential` so rapid reconnects don't get rate-limited harder

## 0.4.5 — 2026-06-21

### 新增 / Added
- **URL 导入**：首页拖拽区新增「导入链接」入口，粘贴 ScreenPal / B 站 / YouTube 等 1500+ 站点的网页地址，内置 yt-dlp sidecar 自动解析并下载，实时显示百分比进度，完成后跳转播放器开始转写。yt-dlp 作为新的 sidecar 二进制打包（macOS universal2 / Windows x64）
  **URL import**: a new "Import link" affordance sits inside the home drop zone — paste a web URL from ScreenPal / Bilibili / YouTube and 1500+ other sites, the bundled yt-dlp sidecar resolves and downloads it with a live percentage, then auto-navigates to the player where transcription kicks off. yt-dlp is packaged as a new sidecar binary (macOS universal2 / Windows x64)
- **链接去重**：重复导入同一个地址时自动命中已下载的视频，零网络开销、瞬时跳转播放器；按内容 SHA-256 兜底去重，不同来源同一内容不重复占用磁盘
  **Link dedup**: re-importing the same URL short-circuits to the already-downloaded video with zero network I/O and an instant jump to the player; content SHA-256 remains the backstop so different-source-same-content never double-spends disk
- 新增 [`DISCLAIMER.md`](./DISCLAIMER.md)（中英双语）：明确 URL 导入为通用下载工具，仅供导入你有权访问的内容，用户自行遵守当地版权法与各站点服务条款
  Added [`DISCLAIMER.md`](./DISCLAIMER.md) (zh + en): clarifies that URL import is a general-purpose downloader intended only for content you have the right to access; users must comply with their jurisdiction's copyright law and each source site's ToS

### 修复 / Fixed
- URL 导入首次使用即 500：数据库 `user_version` 被其他分支的迁移推高后，本版本的 `ALTER TABLE … ADD COLUMN source_url` 被跳过，列缺失导致查询报 `no such column`。新增 `ensureColumn` 自愈逻辑，无论 `user_version` 如何都确保列存在
  URL import 500'd on first use: the DB's `user_version` had been bumped past this branch's migration by another branch, so `ALTER TABLE … ADD COLUMN source_url` was skipped and the missing column threw `no such column` on lookup. Added an `ensureColumn` self-heal that guarantees the column exists regardless of how `user_version` was bumped
- dev:desktop 模式下 yt-dlp 找不到（`exited with code -2`）：`SUBCAST_RESOURCES_PATH` 在 dev 模式指向空的 `resources/` 目录，回退到 PATH 又无 yt-dlp。改为额外尝试仓库本地的 `binaries/<plat>/yt-dlp`
  yt-dlp not found in `dev:desktop` mode (`exited with code -2`): `SUBCAST_RESOURCES_PATH` points at an empty `resources/` dir in dev, and the PATH fallback found nothing. Now also tries the repo-local `binaries/<plat>/yt-dlp`
- 网络偶发超时（`Read timed out`）导致导入失败：为 yt-dlp 加 `--socket-timeout 60` / `--retries 10` / `--fragment-retries 10`，并向子进程透传 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（Electron spawn 默认不继承）
  Transient network stalls (`Read timed out`) failed imports: added `--socket-timeout 60` / `--retries 10` / `--fragment-retries 10` to the yt-dlp spawn, and forwarded `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` to the child (Electron's spawn does not inherit them by default)
- 下载进度条从 0 直接跳到 100：yt-dlp 初始 tick 的 `at Unknown B/s` 行被旧正则丢弃，且进度条无过渡动画。解析改为容错（Unknown 时 speed/eta 返回 undefined 而非丢帧），并给进度条加 0.4s ease-out 平滑
  Download progress jumped 0 → 100 with no middle: yt-dlp's opening `at Unknown B/s` ticks were dropped by the strict regex, and the bar had no transition. The parser now tolerates Unknown (returns undefined for speed/eta instead of dropping the frame) and the bar gets a 0.4s ease-out
- URL 导入期间上传按钮误显「上传中」、顶部提示条与进度条信息重复：按钮文案改为仅在真实文件上传时显示「上传中」；URL 导入仅用内联进度条反馈，错误才推到顶部 Alert
  Upload button mislabeled "uploading…" and the top banner duplicated the inline progress during URL import: the label now reads "uploading…" only for real file uploads; URL import relies on the inline bar, with only errors surfacing to the top Alert

## 0.4.1 — 2026-06-19

### 修复 / Fixed
- 翻译 / AI 摘要功能在 macOS 打包版中完全不可用：ggml-org 预编译 llama-server 是动态链接版但未附带 dylib，运行时 dyld 找不到 `libllama.dylib` 直接崩溃。改为在 CI 中从源码编译 llama.cpp（`-DBUILD_SHARED_LIBS=OFF`），产出自包含的静态二进制
  Translation / AI Insights were completely broken in the macOS packaged app: the prebuilt llama-server was dynamically linked but its dylibs weren't shipped, so dyld aborted at runtime. Now llama.cpp is compiled from source in CI (`-DBUILD_SHARED_LIBS=OFF`) to produce a self-contained static binary
- 清空缓存 / 删除单个视频 / 重试转写时报 `FOREIGN KEY constraint failed`：`dub_tasks`、`dub_variants`、`dub_segments`、`video_export_tasks` 等表引用了 `videos` 但不在删除列表中；且 `PRAGMA foreign_keys=OFF` 在事务内是空操作（SQLite 限制）。已补全所有依赖表，并将 pragma 移到事务外
  "Clear all" / single-video delete / transcribe retry threw `FOREIGN KEY constraint failed`: `dub_tasks`, `dub_variants`, `dub_segments`, `video_export_tasks` etc. FK'd to `videos` but weren't in the deletion list; and `PRAGMA foreign_keys=OFF` inside a transaction is a no-op. All dependent tables now covered, pragma moved outside the transaction
- Windows 打包版启动即崩（`file:///_entry.js`）：ESM 模块在 Windows asar 内的 `import.meta.url` 返回非法路径。改用 `app.getAppPath()` 定位入口
  Windows packaged app crashed at startup (`file:///_entry.js`): `import.meta.url` returns an invalid path for ESM modules inside asar on Windows. Replaced with `app.getAppPath()`
- GitHub Actions 打包流水线修复：whisper-cli / llama-server artifact 完整性、Windows VS2026 兼容、proxy 绕过、fetch 超时、dylib 打包等 10+ 处问题
  GitHub Actions release pipeline fixed: whisper-cli / llama-server artifact completeness, Windows VS2026 compatibility, proxy bypass, fetch timeout, dylib bundling, and 10+ other issues

## 0.4.0 — 2026-05-18

### 新增 / Added
- 界面新增繁体中文、日语、西班牙语，原有简体中文 / 英语保留；语言切换从二态按钮升级为多选下拉菜单，按钮上保留各语言的原生字符标识（EN / 简 / 繁 / あ / ES）
  UI now ships Traditional Chinese, Japanese, and Spanish in addition to the existing Simplified Chinese and English; the 2-state language toggle is upgraded to a multi-locale dropdown that keeps a script-native short label on the trigger (EN / 简 / 繁 / あ / ES)

### 修复 / Fixed
- 桌面端窗口隐藏 / 最小化时自动暂停正在播放的媒体，避免后台仍在出声
  Desktop window now pauses playing media when hidden or minimized, so audio doesn't keep running in the background
- 批量暂存与清空缓存路径修复：补齐 stage / commit API，删除媒体图时更稳健
  Batch staging and cache-clear paths tightened — staging / commit APIs filled in, media-graph deletion hardened

### 变更 / Changed
- 播放器顶栏只保留操作按钮；缓存 / 转写中 / 完成 / 翻译进度 / 说话人状态等信息下移到视频名下方的 meta 行，作为"状态指示"而非"按钮"
  Player toolbar now holds actions only; status chips (cache / transcribing / done / translation progress / diarize state) moved into a meta info row under the video name so they read as vital signs, not actions
- 右侧面板标题由"字幕"改为"索引"，配 (i) 提示说明：用于搜索 / 定位 / 校对，不替代主画面字幕
  Right panel header renamed from "Subtitles" to "Index" with an info tooltip clarifying its search / navigation role versus on-screen captions
- 短视频的波形播放进度更平滑（去掉跳跃感）
  Waveform progress on short videos is smoother (no more jitter)

## 0.3.7 — 2026-05-17

### 修复 / Fixed
- macOS 打包版 `sherpa-onnx-node` 平台 native addon 放回 Nitro runtime 实际解析的 sibling package 路径，修复说话人识别启动时报 `Could not find sherpa-onnx-node`
  Packaged macOS builds now keep the sherpa-onnx native addon at the sibling package path resolved by Nitro runtime, fixing `Could not find sherpa-onnx-node`
- macOS artifact verify 增加 `app.asar` metadata 检查，确保 unpacked native addon 不只是物理存在，也能被 `require()` 解析到
  macOS artifact verification now inspects `app.asar` metadata so unpacked native addons must also be resolvable by `require()`
- 说话人识别必须等原文转写任务完成后才能启动，避免只基于部分 chunks 提前跑完
  Speaker diarization now waits for completed transcription output instead of starting from partial chunk rows
- 播放器在"识别发言人"按钮隐藏时不再显示连续两条分隔线
  The player toolbar no longer shows duplicate adjacent dividers when the speaker diarization action is hidden

## 0.3.5 — 2026-05-16

### 修复 / Fixed
- 清空资源库会先暂停转写 / 翻译 / AI 总结队列，取消 queued / running 任务并等待 active worker 退出，再删除文件和数据库媒体图，避免 worker 在清库时继续写文件或 DB
  Clear-all now pauses transcription / LLM queues, cancels queued / running tasks, waits for active workers to exit, then deletes files and the media DB graph
- 资源库清空、单个删除、重新转写共用同一套媒体图删除逻辑，并兼容历史 diarization 外键表，避免 `FOREIGN KEY constraint failed`
  Cache clear, single delete, and retry transcription now share one media graph deletion path, including legacy diarization FK tables
- macOS 发布包增加 artifact verify 门禁，检查 `whisper-cli` / dylib 可执行性、rpath、`otool` 和 `strings` 中的构建机路径残留
  macOS release builds now verify sidecar executability, rpaths, and build-machine path leakage in `otool` / `strings`

## 0.3.2 — 2026-05-16

### 修复 / Fixed
- macOS 打包版 `whisper-cli` 不再依赖构建机 `node_modules` 目录；现在随包携带 `libwhisper` / `libggml` dylib，并在 `afterPack` 改写为相对 `@loader_path` rpath
  Packaged macOS `whisper-cli` no longer depends on the build machine's `node_modules`; bundled `libwhisper` / `libggml` dylibs are loaded through relative `@loader_path` rpaths
- 诊断包在 debug mode 关闭时会脱敏 stderr 文本里嵌入的绝对路径
  Diagnostic exports now redact absolute paths embedded in stderr text when debug mode is disabled

## 0.3.0 — 2026-05-15

### 智能转录与播放体验升级 / Smarter transcription & player UX

**主要变化 / Major change**：Whisper 不再"看见"静音，转录质量与速度双双提升；播放器拿到全新音轨样式的进度条与"模型忙碌"指示。
Whisper no longer sees silence — transcription is both more accurate and faster; the player gains a waveform-style seek bar and a busy indicator next to the model chip.

#### 新增 / Added
- **Silero VAD 智能切片** — 转录前自动识别说话段，跳过音乐 / 静音 / 噪声片段；长视频提速 30-50%，幻觉显著减少
  Silero VAD speech-aware chunking — speech regions auto-detected before transcription, music / silence / noise skipped; long videos 30-50% faster, hallucinations dramatically reduced
- **波形进度条** — 播放器底部进度条改成音轨样式，已播放区域 primary 色高亮 + 锐利 playhead 竖线；点击 / 拖动 seek，rAF 平滑预测 60Hz 移动
  Waveform-style seek bar — primary-tinted played region + sharp playhead line; click / drag to scrub with rAF-smoothed 60 Hz motion
- **Header 模型 chip 忙碌指示** — 任务运行中（模型未释放）时 chip 背景泛起 primary 色横扫光带 + Boxes 图标变亮
  Models chip in header shows a primary-colored sweep + tinted icon while a task is running
- **自动选最快下载源** — Setup wizard 不再要求用户判断"中国大陆应该勾 hf-mirror"；并发探测 huggingface.co 和 hf-mirror.com，挑下载快的那个
  Auto-fastest download source — wizard probes huggingface.co + hf-mirror.com in parallel and picks the faster one; manual override still available
- **诊断包文件名含设备指纹** — `subcast-diag-<version>-<platform>-<arch>-<deviceHash>-<ts>.zip`，多用户报告不再撞名
  Diagnostic bundle filename includes app version, platform, arch, and a 6-char device hash so multiple test users' reports are distinguishable
- **Settings → 切分策略开关** — 可选回退到旧的固定 30 秒切片（仅在 VAD 在你机器上不稳定时使用）
  Settings → chunking strategy toggle — opt-out fallback to the legacy fixed 30 s slicing path

#### 变更 / Changed
- 字幕面板字体层级收紧（章节标题、要点改为 `text-sm`；section 标签缩成 `text-2xs`），整体读起来不再"满"
  Insights panel typography tightened — section labels at 11 px, chapter title at 14 px medium
- `transcribeChunk` 签名简化为 `(startSec, endSec)`，不再耦合"第 N 个 30 秒"的固定假设
  `transcribeChunk` now takes explicit `(startSec, endSec)` range instead of `(chunkIdx, chunkSizeSec, totalDurationSec)`
- llama.cpp 二进制下载切换到上游 GitHub Release（不再依赖 subcast-binaries mirror），首次安装走 gh-proxy.com 加速
  llama.cpp binary fetcher reads from upstream `ggml-org/llama.cpp` releases (via gh-proxy.com mirror by default)

#### 修复 / Fixed
- macOS 菜单栏 tray 图标在打包后**不可见** — 资源没进包 + ad-hoc 签名 + 浏览器下载的 quarantine xattr 三连问题。修复：打包时纳入 `assets/tray/**`、运行时启动剥 quarantine、加 @2x retina 显示
  macOS tray icon was invisible in packaged builds — fixed by bundling tray assets, stripping `com.apple.quarantine` at boot, and registering `@2x` retina representation
- `PARSE_FAILED: neither summary nor chapters extractable` — 小模型不写 `## Summary` / `## Chapters` 标题时也能解析散文输出
  Insights parser now salvages prose-only output when the model drops the markdown headings
- AI 总结面板"基于已变更的设置生成"的**误报** — v0.1 缓存的 `_meta.ollamaModel: "qwen2.5:7b"` 与 v0.2+ 的 `"7b"` 是同一模型，比较前归一化
  False "outdated" warning on insights cached pre-0.2 — model id normalization handles the legacy full-name vs tier-id mismatch
- 视频字幕显示在**进度条下方** — VTTCue 默认位置忽略了自定义控件栏，显式设置 `line = -3` 把字幕抬到控件之上
  Subtitles appeared *below* the seek bar — VTTCue line position now pinned above the custom controls overlay
- 字幕进度条点击 seek 后**回退一点** — rAF 预测基线 + codec keyframe snap 双重抑制
  Post-seek micro-retreat on the waveform progress bar — fixed via rAF baseline resync on user action + 500 ms suppression window for codec keyframe corrections
- `whisper-cli` 启动后立刻 SIGABRT — Apple Silicon 上 ad-hoc 签名 + quarantine 组合被 amfid 杀；现在启动时主动 `xattr -dr com.apple.quarantine` 整个 `Contents/Resources/`
  whisper-cli / llama-server SIGABRT on first launch — auto-strip quarantine xattr from bundled resources on macOS boot
- `spawn_exit` 日志现在带 stderr 尾部 500 字 — 之前只有 hashed sigName，根本看不出失败原因
  `spawn_exit` log now includes the last 500 chars of stderr on abnormal exit, so packaging regressions surface in diagnostic bundles instead of as opaque SIGABRT codes

---

## 0.2.0 — 2026-05-13

### 内置 AI 推理引擎 / Bundled AI inference engine

**主要变化 / Major change**：Subcast 不再需要 Ollama。AI Insights / 翻译开箱即用。
Subcast no longer requires Ollama. AI Insights / translation work out of the box.

#### 新增 / Added
- 内置 `llama.cpp` 推理引擎（`llama-server` sidecar，~15 MB binary）
  Bundled `llama.cpp` inference engine (`llama-server` sidecar, ~15 MB binary)
- 模型下载 UI 直接在 setup wizard 内，支持 huggingface / hf-mirror / modelscope 镜像
  Model download UI inside setup wizard, supports huggingface / hf-mirror / modelscope mirrors
- 自动扫描 LM Studio / Jan / `~/.cache/llama.cpp` 已有的 Qwen GGUF，提供 symlink / copy 复用
  Auto-scan existing Qwen GGUF files in LM Studio / Jan / `~/.cache/llama.cpp` with symlink / copy reuse
- AI 推理懒启动 + 5 分钟空闲卸载，转录-only 场景下零额外 RAM
  Lazy-spawn + 5-minute idle shutdown of inference server — zero extra RAM when not using AI
- 启动时自动清理上次崩溃残留的 sidecar 进程
  Auto-cleanup of orphan sidecar processes from prior crashes at boot
- Settings → Models 标签页新增 LLM 管理（切换 / 删除 / 跳转下载更多）
  Settings → Models tab — LLM management (switch / delete / download more)

#### 变更 / Changed
- Setup wizard 从 3 步减为 2 步（删除 Ollama 检测步骤）
  Setup wizard collapsed from 3 steps to 2 (Ollama detection step removed)
- AppHeader 模型 chip 现在显示 Whisper · LLM 档位 id，琥珀色点表示未安装
  AppHeader model chip now shows Whisper · LLM tier id, amber dot indicates uninstalled
- 翻译管线改走 `LLMBackend` 抽象，未来切换推理后端（云端 / Apple Intelligence）只需替换一个文件
  Translation pipeline routed through `LLMBackend` abstraction; future backend swaps (cloud / Apple Intelligence) are single-file changes

#### 删除 / Removed
- 所有 Ollama 检测、Qwen pull、`~/.ollama/id_ed25519` 修复相关代码
  All Ollama detection, Qwen pull, `~/.ollama/id_ed25519` fix-key code paths

### 0.1 用户升级须知 / Upgrade notes for 0.1 users
升级后首次启动会进入 setup wizard step 2（LLM 模型），从 `settings.ollamaModel` 智能预选档位。如果之前装的 Ollama 仅用于 Subcast，现在可以卸载（Subcast 不再读取 `~/.ollama/`）。
After upgrading, first launch enters setup wizard step 2 (LLM model), with tier pre-selected from your legacy `settings.ollamaModel`. If your Ollama install was Subcast-only, you can uninstall it now — Subcast no longer reads `~/.ollama/`.

### 硬件门槛 / Hardware requirements
- 3B model: 8 GB RAM minimum
- 7B model: 16 GB RAM recommended
- 14B model: 32 GB RAM recommended (Apple Silicon)
- 8 GB Mac 用户在 wizard 中会看到提示，建议跳过 AI 设置
  8 GB Mac users see a warning in the wizard suggesting to skip AI setup
