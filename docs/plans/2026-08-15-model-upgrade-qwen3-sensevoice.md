# 模型升级方案：Qwen3（LLM）+ SenseVoice（ASR 中英档）

日期：2026-08-15
分支：`feat/model-upgrade-qwen3-sensevoice`（基于 main @ a1abcb8）
决策：不依赖 `feature/subcast-lite`；lite 合并时 SenseVoice 的两个分发点（transcribeQueue.runWorker / transcribe.get readiness）迁入其 engine registry。

## 背景与目标

main 当前模型栈（2024 年代际）相对 2026-08 生态已落后：

| 位置 | 现状 | 升级 |
|------|------|------|
| LLM（翻译/摘要） | Qwen2.5-3B/7B/14B-Instruct Q4_K_M（2024-09） | Qwen3-4B/8B/14B Q4_K_M：多语言大幅提升，同档质量体积近乎减半 |
| ASR | whisper.cpp + OpenAI Whisper 系（large-v3 为 2023 模型） | 新增 SenseVoice-Small 中英档：中文准确率优于 whisper-large、CPU 推理 ~15x 提速 |
| VAD | Silero VAD | 不变（事实标准） |
| Diarization | pyannote-seg-3.0 + campplus | 不变（收益小） |

两个阶段独立可发版：Phase 1 → 0.5.0，Phase 2 → 0.6.0。

## Phase 1：Qwen2.5 → Qwen3

### 目标
- 模型目录换 Qwen3，档位 id `'3b'|'7b'|'14b'` → `'4b'|'8b'|'14b'`（真实尺寸）。
- thinking 模式显式关闭并做防御性剥离，translate/insights 解析零改动。
- llama.cpp pin 升级（b4524 → 最新稳定）。

### 交付物
- `shared/llmModels.ts`：`Qwen3-{4B,8B,14B}-Q4_K_M.gguf`（~2.6/5.0/9.0GB，RAM 8/16/32GB），bartowski 双镜像（仓库 `Qwen3-{N}B-GGUF`，无 Instruct 后缀），推荐档 `'8b'`；导出 `LLM_MODEL_IDS` 供 API 层推导。
- `server/utils/settings.ts`：loadSettings 一次性迁移 `'3b'→'4b'`、`'7b'→'8b'`；Ollama 迁移正则兼容 `qwen3:`。
- 消除硬编码 id：`server/api/settings.put.ts`、`server/api/desktop/llm/status.get.ts`、`install.post.ts`、`[model].delete.ts`（改用 `LLM_MODEL_IDS`）；`desktop/modelManager/llmScan.ts` FILENAME_RE → `/^Qwen3-(4B|8B|14B)-Q4_K_M\.gguf$/i`；`llmInstall.ts` label → `Qwen3 ${id}`。
- `server/utils/llmServer.ts`：spawn 加 `--ctx-size 16384`（默认 4096 挤占摘要 maxTokens=4096）。
- `server/utils/llmBackendLlamaServer.ts`：请求体加 `chat_template_kwargs.enable_thinking=false`；响应/流式忽略 `reasoning_content`；backend 层统一剥离 content 内 `<think>…</think>`。
- `scripts/fetch-llama-server.mjs` + `.github/workflows/build-llama-server.yml`：两处 pin 同步升级。
- `app/pages/setup-wizard/index.vue`：tier 列表/默认/降级顺序 `['4b','8b','14b']`；i18n 五语言 Qwen 2.5 → Qwen 3。

### 关键实现决策
- **不做 `/no_think` 软开关**：依赖新版 llama.cpp 的 `chat_template_kwargs` 字段 + backend 层 `<think>` 剥离兜底，prompt 零改动。
- **剥离只做 backend 层**：translate.ts parseJsonArray / insights.ts parseInsights 不感知 thinking。

### 验证标准
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test:run` 全绿（含新增：thinking 适配、settings 旧值迁移）
- [ ] dev 模式真实下载 Qwen3-4B，翻译+摘要冒烟无 `<think>` 泄漏
- [ ] 新 llama-server `--version` 输出版本号、加载 Qwen3 GGUF 成功

## Phase 2：SenseVoice-Small 转写引擎

### 目标
- 新增第二转写引擎（中/英/日/韩/粤），按需下载 int8 ONNX（~240MB），复用现有 VAD/队列/产物基础设施。

### 交付物
- `server/utils/settings.ts` + `settings.put.ts`：`transcribeEngine: 'whisper' | 'sensevoice'`（默认 whisper，JSON blob 加字段向后兼容）。
- `server/utils/sensevoice/`：常驻 worker（消息协议 load/recognize/dispose），`sherpa.OfflineRecognizer` + `model.senseVoice` + ITN，`createRequire` 加载 sherpa-onnx-node（^1.13.2 已在依赖、nuxt external 已配），WAV 读取复用 `diarize/readWav.ts` readWavF32。
- 时间戳对齐：复用 `detectSpeechSegments` + `planChunksFromVad`（SenseVoice cap ~10s，whisper 30s）；每段 → `Cue{startMs,endMs,text}` 段级 cue；chunks 表/original.vtt/meta.json/SSE 全复用。
- `transcribeQueue.runWorker` 按 engine 分发；`transcribe.get.ts` readiness 按 engine 分支。
- `desktop/modelManager/senseVoiceConfig.ts`：sherpa-onnx GitHub release 资产（model.int8.onnx + tokens.txt）+ gh-proxy + size 校验；走现有 downloader/downloadRace；`shared/installContracts.ts` 扩展快照类型。
- `scripts/fetch-sensevoice.mjs`（dev 模式，仿 fetch-diarize-models.mjs）。
- UI：Models.vue 转写引擎选择 + SenseVoice 模型卡片；`models.get.ts` 聚合。

### 关键实现决策
- **常驻 worker 而非 diarize 的一次性 worker**：一个转写任务要推理几十段，避免重复加载模型。
- **段级 cue**：SenseVoice 无 cue 级时间戳，接受 VAD 段粒度（通常 2–8s）；段内细切留作后续迭代，精确时间轴导出用 whisper。
- **int8 量化**：~240MB（fp32 ~900MB），CPU 精度损失小。
- **不进 extraResources**：按需下载，electron-builder 配置不动。

### 关键实现决策（后续追加：内置置换方案 B）
- **默认引擎翻转 + 内置换为 SenseVoice**：app 面向中英文用户，向导默认已选 SenseVoice 后「默认引擎 + 强制首启下载 166MB」成为最差组合（且 gh-proxy 对该文件下载不稳定已实测）。决策：**去掉内置 ggml-base.bin（148MB），改为内置 SenseVoice int8（~237MB，净 +90MB）**，全部 whisper 档位按需下载；`DEFAULT_SETTINGS.transcribeEngine` 翻为 `'sensevoice'`（三处 `?? 'whisper'` 兜底同步）。首启播种走 seedBundledSenseVoice.ts（双文件 symlink + `.bundled-sensevoice-dismissed` marker，delete handler 写 marker 防复活）；fetch:sensevoice 接入三条 build 链；verify-mac-artifact 校验换为 sensevoice 双文件。旧用户 base seed 的 dismissed marker 逻辑保留（防旧安装复活）。

### 验证标准
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test:run` 全绿（worker 源码、段→cue 纯函数、settings 校验、queue 分发 mock 用例）
- [ ] 真实中文音频冒烟：SenseVoice vs whisper-base/small 对比（本地手跑，模型文件不进 CI/git）

## 风险与对策
- llama.cpp 新版二进制兼容：官方静态 zip，afterPack/rpath 只针对 whisper-cli；`verify-mac-artifact.mjs` 确认。
- Qwen3 GGUF 单文件假设：Q4_K_M 均 <10GB 单文件；实施时核对 bartowski 实际资产名。
- cue 粒度粗于 whisper：VAD cap 10s 缓解；导出精确时间轴走 whisper。
- 中文网络：HF/hf-mirror 竞速 + gh-proxy 沿用现有机制。

## 实施差异记录（相对原方案）

- **Qwen3 下载源改为 Qwen 官方仓库**：核实发现 Qwen3 官方 GGUF 仓库（`Qwen/Qwen3-{N}B-GGUF`）Q4_K_M 均为单文件（Qwen2.5 时代官方分片、故用 bartowski 的历史原因已消失），直接用官方源，bartowski `Qwen_Qwen3-*-GGUF` 作为备用说明留在代码注释。
- **ctx-size 定为 8192 而非 16384**：Qwen3-4B KV cache 每 token ~144KB（36 层 × 8 KV 头），16k 预分配 ~2.3GB 会挤爆 8GB 档机器；8192 覆盖实际 prompt 分布（翻译 <1k、摘要典型 3-6k token），超长 prompt 走 llama-server context-shift（与旧默认 4096 行为一致）。
- **llama.cpp b4524 → b10435 连带动态链接适配**（方案未预见）：上游 ~b5xxx 起 macOS 资产从 `.zip` 改 `.tar.gz`、Windows `bin-win-avx2` 改名 `bin-win-cpu`，且 macOS llama-server 变为动态链接薄壳（~33KB + libllama/libggml*.dylib）。处理：fetch 脚本 staging `llama-libs/`（35 个 dylib，cp -a 保留 symlink 链）+ 烘焙 `@loader_path/llama-libs` rpath；electron-builder extraResources 打包 llama-libs；afterPack 的 whisper rpath 手术泛化为 `fixSidecarDylibs(binary, libsDir)` 双方复用；`verify-mac-artifact.mjs` 补 llama-libs/rpath/--version 校验。已本地验证 `llama-server --version`（build 10435）在 staged 布局下可运行。
- **网络实测**：gh-proxy.com 对 GitHub release 大文件不稳定（中断）；`SUBCAST_GH_MIRROR=https://ghproxy.net/` 实测最快（~240KB/s），fetch 脚本镜像机制无需改动（env 覆盖即可）。

## 进度
- [x] Phase 1（Qwen3）：代码+测试完成，typecheck/lint/test 全绿（417 passed）。llama-server b10435 二进制验证通过；真实 Qwen3 GGUF 翻译/摘要冒烟待模型下载（2.5GB，当前网络受限，未完成）。
- [x] Phase 2（SenseVoice）：代码+测试完成，全绿。模型下载与真实音频冒烟进行中。
