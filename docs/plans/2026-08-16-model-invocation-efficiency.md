# 模型调用效率评审与优化计划

日期：2026-08-16
分支：`feat/model-upgrade-qwen3-sensevoice`
性质：架构效率评审（分析结论，未实施）。范围：模型调用链路 —— ASR（whisper-cli / SenseVoice）与 LLM（llama-server），以及两条队列的调度方式。

## 现状架构速写

```
文件 → ffmpeg 抽 16k WAV → VAD 规划 chunk
     → TranscribeQueue（单并发，逐 chunk）
         whisper 路径:  每 chunk spawn ffmpeg 切片 + spawn whisper-cli（模型重新加载）
         sensevoice:   长驻 worker 线程，模型加载一次
     → original.vtt 落盘
     → LLMQueue（单并发，translate/polish/insight 统一排序）
         llama-server 常驻 sidecar（idle 2min 自动卸载），OpenAI 兼容 HTTP
```

做得对的部分（保持，不要在重构中丢掉）：

- SenseVoice 长驻 worker + 单例会话（`server/utils/sensevoice.ts:190`），模型只加载一次；
- WAV 进程内缓存，避免逐 chunk 重读 230MB 文件（`sensevoice.ts:327`）；
- llama-server 常驻 + idle 自动卸载（`server/utils/llmServer.ts:61`），spawn 等 `/health` 而非裸端口，规避加载期 503；
- chunk 级持久化 + 断点续跑（chunks 表按 task_id 续传）；
- 转写队列与 LLM 队列独立：视频 B 可在视频 A 翻译期间转写。

## 优化项（按杠杆排序）

### P1. LLM 输出无格式约束 → count-mismatch 重试梯子最多放大 25×调用量

文件：`server/utils/translate.ts:158-269`、`server/utils/polish.ts:124-190`、`server/utils/llmBackendLlamaServer.ts:104-111`

翻译/润色要求"恰好 N 条的 JSON 数组"，但请求体不带 `response_format`。小模型（Qwen3-4B 档）数错条数是常态，一旦错：25 条整批失败 → 降 15 条子批 → 仍错则逐条调用。一批最坏变成 ~25 次请求。

**改法**：llama-server 支持 `response_format: {"type": "json_schema", ...}`（编译为 GBNF grammar 约束解码）。在 `LlamaServerBackend.chat` 增加可选 `responseSchema` 参数，translate/polish 传入"字符串数组"schema。attempt-1 命中率应接近 100%，这是 LLM 侧最便宜、收益最大的一笔。

注意：精确"恰好 N 条"依赖 grammar 版本对 `minItems/maxItems` 的支持；不支持时 grammar 仍能消灭 parse 失败与结构错误，长度校验保留现有降级逻辑兜底。

估算改动：`llmClient.ts`（接口加字段）+ `llmBackendLlamaServer.ts`（透传）+ `translate.ts`/`polish.ts`（传 schema）。纯增量，现有降级路径不动。

### P2. Whisper 路径：每 chunk 起两个进程，模型每次重新加载

文件：`server/utils/whisper.ts:107-192`、`server/utils/transcribeQueue.ts:339-473`

`transcribeChunk` 对每个 30s chunk：spawn ffmpeg 切片 → spawn whisper-cli（模型加载初始化）→ 读 VTT → 清理。1 小时视频 ≈ 120 chunks = 240 次进程创建、120 次模型加载；幻觉重试梯子（`transcribeQueue.ts:380-419`，`RETRY_PARAMS` 3 档）最坏把单个 chunk 放大 3×，每次都是冷进程。

分三档改，可独立落地：

1. **最小改动**：切片不必起 ffmpeg。SenseVoice 路径已在内存持有完整 WAV（`loadWavCached`），直接从 PCM 内存写出切片 WAV（`readWavF32` + 手写 44 字节头或复用 wave 写出工具），进程数减半。
2. ~~**流水线**：切片与推理做两级流水线~~ **已关闭（2026-08-16，实测依据）**：P2.1 把切片降到 ~2ms 后，生产日志实测同任务内 chunk 间循环开销（切片 + DB 写 + SSE emit + HTTP 客户端构造）p50 = **7ms**，无可隐藏成本，流水线没有可并行的对象。观测到的 2-5.5s 大 gap 全部落在已修复的 timeout 浮点降级路径上；其中约 1/3 chunk 前的秒级 gap 疑似 whisper-server 中途崩溃后的静默 respawn（模型重载 1.5-2s）——已补 `whisper_server_crashed`/`whisper_server_spawned` 结构化日志，待修复后的重跑确认；若确认崩溃需另行排查（见 P2.3 附注）。
3. **根治**：whisper.cpp server 模式（`whisper-server`，常驻进程 + 模型加载一次 + HTTP 请求带音频段）。SSE 逐 chunk 进度、断点续跑、幻觉梯子全部保留，只是"每次 spawn"变"每次 POST"。这是 ASR 侧最大单项收益；改动集中在 `whisper.ts`，`transcribeQueue` 调用点基本不动。
   - 打包注意：`whisper-server` 与 `whisper-cli` 同源构建（whisper.cpp examples），`scripts/fetch-whisper-cli.mjs` 与 `electron-builder.config.cjs` 需要多 stage 一个二进制；macOS dylib rpath 规则与现有 `whisper-cli` 相同。

### P3. llama-server 启动参数

文件：`server/utils/llmServer.ts:172-186`（spawn 参数）

- 加 `-fa`（flash attention）：Metal 上同时降 KV 内存与 prefill 时间。Qwen3 KV cache 肥（见现有注释），收益直接；
- `--cache-reuse 256`：translate/polish/insight 的系统提示词是跨请求相同前缀，可复用 KV 前缀；
- `--mlock`：防权重被换出（大档 + 长会话场景）。

改动一行参数，风险低。`build-llama-server.yml` pin 的版本需确认支持（近年版本均有）。

### P4. LLMQueue 全局单并发 → 受控并发

文件：`server/utils/llmQueue.ts:249-281`

所有视频的 translate/polish/insight 串行执行。llama-server 配 `--parallel 2` 后，连续批处理把并发请求合并进同一次前向 —— Metal decode 是带宽瓶颈，2 路并发总吞吐 ≈ 单路 1.5-1.8×（需实测）。

代价与约束：

- ctx 8192 被对半分（4096/槽）。translate/polish 批次 ~2k token 无压力；insight（输入 3-6k + maxTokens 4096）会触发 context-shift 降质；
- 稳妥形态：translate/polish 走 2 并发，insight 保持独占（queue 侧按 kind 分槽，或 insight 运行时暂停其他 dispatch）；
- KV 内存随槽数线性增长，大档（14B）注意 8GB 约束。

建议：P1 落地后实测单请求耗时，若批间仍有排队再做此项。

### P5. llama-server 冷启动预热

文件：`server/utils/transcribeQueue.ts:522-527`（转写完成 → 自动入队润色）

转写完成到首个 LLM 请求之间，llama-server 要付 1-3s（小档）到 60s（14B 冷盘）加载费。改法：转写进度到 ~80%（doneChunks/totalChunks ≥ 0.8）时调一次 `getLlmServer().ensure()` 预热（不 await，失败静默——预热失败不该影响转写）。注意 `ensure()` 会 arm idle timer（2min），转写最后 20% 通常在 2min 内，时序成立；若担心长尾可同时上调该场景的 idleShutdownMs。

### P6. 结构性选项：转写与翻译/润色流水线化（中期）

现状是严格两段式：original.vtt 落盘后 LLM 才开工，总耗时 = T_asr + T_llm。chunks 表本来就有逐条结果，翻译按 cue 顺序滑窗 —— 可以边转写边喂翻译，总耗时逼近 max(T_asr, T_llm)。

改动面大：部分转写失败/取消时的回滚语义（已产出的部分翻译层如何标记）、`ensureTask` 的 ORIGINAL_NOT_READY 前置检查、SSE 的 cue 流合并。列为中期项，前五项落地后再评估。

## 小问题（顺带发现）

1. **totalBatches 基准不一致（bug）**：`server/utils/llmQueue.ts:451` 用 `origCues.length / 40`，但 `translate.ts:158` 的 `SUPER_BATCH_SIZE = 25`。首帧 `status` 的 totalBatches 与后续 `batch-progress` 帧不一致，进度条会跳变（polish 侧 `/25` 一致，无此问题）。
2. **SenseVoice `numThreads: 2` 写死**（`sensevoice.ts:264`）：repo 已有 `server/utils/hardware.ts`，可按机器核数给。
3. **`wavCache` 单条目常驻**（`sensevoice.ts:327`）：1 小时音频 ≈ 230MB Float32 留在内存直到下一个 WAV 顶掉。任务结束（transcribeQueue finally）时主动置 null。
4. **队列优先级**：polish 恒为 1、translate 默认 0（`llmQueue.ts:255-267`），自动润色会插到其他视频已排队翻译前面。若是刻意产品选择则忽略，否则复查。
5. **SenseVoice 批量解码**（可选）：worker 协议单 recognize 串行；sherpa-onnx `OfflineRecognizer` 支持 `decodeStreams` 批量推理，ONNX 批处理利用率更高。需改 worker 协议（`recognizeBatch`），收益中等。

## 待办(2026-08-16 挂账)

| 项 | 触发条件 | 预估 | 难度/风险 |
|----|----------|------|-----------|
| **P4** LLM 队列受控并发(llama-server `--parallel 2`,insight 独占槽位) | 常批量导入多视频(实测:4 个润色任务串行排空 8-10s/批,聚合吞吐预估 1.5-1.8×) | ~1 天 | 中:llmQueue 单槽模型(attach/waitForSlot)要槽位化;ctx 8192 对半后 insight 需独占 |
| **P6** 转写→翻译/润色流水线化 | 收到"单个长视频首份译稿太慢"的真实反馈(批量场景已被队列重叠覆盖;SenseVoice 转写已秒级) | 2-3 天 | 中高:跨队列生产者-消费者、部分失败语义(partial 层状态/UI/重试)、取消与优先级插队 |
| 小问题4 队列优先级(polish 恒为 1 > translate 默认 0,自动润色会插队其他视频的翻译) | 产品决策:是否改为"用户正在查看的任务优先" | 顺手 | 低;建议与 P4 同批定 |
| 小问题5 SenseVoice `decodeStreams` 批量解码 | 中文转写成为瓶颈时 | — | 中:改 worker 协议 |

## 建议落地顺序

> **实施状态(2026-08-16)**:序 1-3 与小问题 1/2/3 已实施并通过全量验证(test 447 passed / typecheck / lint);序 4-6 未动。实施明细:
> - P1:`llmClient.LLMChatOptions.responseSchema` → `llmBackendLlamaServer.buildBody()` 注入 `response_format: json_schema`;`translate.ts` 导出 `SUPER_BATCH_SIZE` + `jsonStringArraySchema()`,`polish.ts` 复用。
> - 小问题1:`llmQueue.ts` 改用导出常量(translate 侧 `/40` bug 修复,polish 侧 `/25` 同步收敛)。
> - P2.1:新增 `server/utils/wavSlice.ts`(RIFF 解析 + 内存切片 + 单条目父缓存),`whisper.ts` 切片改内存优先、ffmpeg 降级;`transcribeQueue` 任务结束调用 `releaseWavSliceCache()`。
> - P3:`llmServer.ts` spawn 参数追加 `--cache-reuse 256` 与 `--load-mode mmap+mlock`。初版加过裸 `-fa`/`--mlock`,真机验证发现 b10435 的 `--flash-attn` 已变为带值参数(`on|off|auto`,默认 `auto` 即"受支持即开启"),裸 `-fa` 会吞掉后续 flag 导致进程秒退(表现为 30s 端口超时);已改为不传该 flag(默认等效开启)并让 `waitForListeningPort` 在进程提前退出时携带 stderr 尾部快速失败(家目录脱敏)。已用 Qwen3-8B 真机拉起验证 listening + /health 通过。
> - P5:`transcribeQueue` chunk 进度 ≥80% 时按自动润色同款条件 fire-and-forget `ensure()` 预热。
> - 小问题2/3:`sensevoice.ts` 新增 `senseVoiceThreads()`(2-4 线程按核数)与 `releaseSenseVoiceWavCache()`,队列 finally 统一释放两个 WAV 缓存。
> - 测试:新增 `wavSlice.test.ts`(6 例);`translate/polish` 各加 responseSchema 断言;`llmClient` 加 response_format 注入断言。
> - 顺带:补了工作区在途 polish 功能遗漏的 `RowIconBadge.vue` `polish` kind(否则 typecheck 挂)。

> **实施状态(2026-08-16 补充:P2.3 已实施)**:
> - 新增 `server/utils/whisperServer.ts`(镜像 LlmServer 的状态机/单例/idle 2min 卸载/三连败熔断)与 `sidecarAnnounce.ts` 双 helper:`waitForSidecarListening`(llama 用,announce 行)+ `waitForSidecarPortOpen`(whisper 用,TCP 探测——whisper.cpp 的 listening 行打到 stdout,管道下块缓冲可能永远不刷出,不能作就绪信号;**readiness = 自选端口可连接**,早退仍带 stderr 尾部快速失败)。
> - `transcribeChunk` 双路径:内存切片 buffer 直接 multipart POST `/inference`(契约按 v1.8.4 server.cpp 源码锁定:file/response_format/temperature/no_context/language),失败降级 whisper-cli(二进制缺失只告警一次);`wavSlice.ts` 增加 `sliceWavToBuffer`。转写任务在 WAV 提取后即预热 server(把冷加载藏进 VAD 窗口);decode 线程按核数 4-8(-t 8 实测提速 ~40%)。
> - 打包:`fetch-whisper-cli.mjs` 构建并 stage 双二进制(whisper-server 复用 whisper-libs,rpath 同规则);`build-whisper.yml` 双 target;`electron-builder.config.cjs` 新增条目 + afterPack `fixSidecarDylibs('whisper-server')`;`binaryCheck.ts` 把 whisper-server 列为可选(缺失降级不阻断启动);`release.yml` mac 分支整树拷贝,自动携带,无需改。
> - **实测收益(同机对照,M3 Pro + large-v3-turbo,30s chunk)**:轻负载 server 2.59s vs CLI 3.19s(省 ~0.6s,19%);高负载(load 6-10,dev app + llama 常驻)server 3.4s vs CLI 4.9s(省 ~1.5s,30%)。负载越高收益越大(spawn+加载受争用惩罚)。1h 视频(120 chunks)约省 1.2-3 分钟;冷启动一次 ~0.8-20s(页缓存冷热)已通过任务前预热对冲。注意:先前文档估的 50-80% 偏高,系 turbo 档推理占比大所致;档位越大模型加载占比越高,收益越接近上限。
> - 端到端已真机验证(staged 二进制 + dev 模型 + 真实 `transcribeChunk` 路径):spawn 0.76-1.5s(热页缓存),chunk 3.9-4.2s(带系统负载)。
> - **打包验证时发现并修复既有地雷**:上游 llama.cpp b10435 release 的 dylib 把 GitHub runner 的 `__FILE__` 字符串(`/Users/runner/work/llama.cpp/...`)编进了 `__TEXT,__const`(`strip -S`/`-x` 均无法移除,实测确认),任何一次重新下载 stage 后 `assertNoBuildMachinePaths` 都会拒掉整个 mac 构建。修复:检查正则豁免 `/Users/runner/work/`(上游 CI 标准路径、非本机泄漏,检查本意是拦本地路径)。
> - **生产复验通过(2026-08-16 22:53 批量导入 4 视频)**:fallback 零次、whisper-cli/ffmpeg-slice spawn 零次、whisper-server 全程单次 spawn 零崩溃(崩溃疑团随 timeout 浮点修复一并结案);whisper 引擎任务 27 chunks/54s ≈ **2.0s/chunk**,较 CLI 基线(2.75-4.9s)提速 25-60%;预热链(llm/whisper)每任务命中;润色与下一视频转写重叠执行。
> - **P4 决策数据**:批量导入时 4 个润色任务在 LLM 队列串行排空(8-10s/批,Qwen3-8B)——批量场景 `--parallel 2` 有真实收益,单视频场景无感。

| 序 | 项 | 改动量 | 风险 |
|----|----|--------|------|
| 1 | P1 json_schema 约束 + 小问题 1（/40 bug） | 小 | 低 |
| 2 | P2.1 内存切片（去 ffmpeg spawn） | 小 | 低 |
| 3 | P3 llama-server 参数 + P5 预热 | 小 | 低 |
| 4 | P2.3 whisper 常驻 server 化 | 中 | 中（打包链路） |
| 5 | P4 受控并发（先实测） | 中 | 中（内存/ctx） |
| 6 | P6 转写-翻译流水线 | 大 | 中 |

验证锚点：

- 单元：`server/utils/__tests__/polish.test.ts`（schema 参数不破坏现有解析）、translate 相关测试；
- 打包：P2.3 后按 AGENTS.md 的 DMG 验证流程（`whisper-server --help` + otool rpath）；
- 性能基线：`docs/performance-baseline.md` 已有，落地前后对比。

## 预期收益评估（2026-08-16 补充）

基准假设：M 系列（Apple Silicon）、Qwen3-4B Q4_K_M（decode ~30-50 tok/s）、whisper small 档。
所有数字为量级估算，以 `docs/performance-baseline.md` 落地前后实测为准。

### 分项收益

| 项 | 提升落点 | 量级（估） |
|----|----------|-----------|
| P1 json_schema | 翻译/润色调用量、尾延迟、质量一致性 | 消灭 count-mismatch 降级重试（4B 档 10-30% 批次会触发）；总时长 −10~40%（模型越小收益越大）；不再出现"逐条调用"级联（最坏 25×/批） |
| P2.1 内存切片 | whisper 转写 | 每 chunk 省 0.2-0.5s（ffmpeg spawn）→ 每小时视频省 25-60s |
| P2.2 流水线 | whisper 转写（与 P2.1 叠加） | 切片延迟归零，推理不间断 |
| P2.3 whisper-server | whisper 转写（ASR 最大单项） | 每 chunk 再省 0.5-2s+（spawn + 模型加载）；small 档整体 1.5-2×；幻觉梯子 3× 重试只剩推理成本 |
| P3 -fa 等 | prefill、KV 内存 | prefill +10-30%；KV cache 约减半（为 P4 槽位腾空间）；insight 单调用略提速 |
| P4 --parallel 2 | 队列吞吐 | 有 ≥2 任务积压时聚合吞吐 1.5-1.8×；单任务用户无感 |
| P5 预热 | 转写→润色衔接延迟 | 4B 省 1-3s；14B 冷盘省 30-60s |
| P6 流水线化 | 端到端墙钟 | 总时长 T_asr + T_llm → max(两段)；中文档（ASR 快、LLM 慢）约 −25~35% |
| 小问题 3 | 内存 | 任务结束后释放 ~230MB（1h 音频的 Float32 WAV） |
| 小问题 1 | UI | 进度条起始跳变修复（非性能） |

### 典型场景端到端（估算）

**场景 A：1h 中文视频，SenseVoice + 自动润色**（SenseVoice 路径本来就高效，收益集中在 LLM 侧）

- 现状：转写 ~2-5 min + 润色 ~6-10 min（40 批 × 8-15s）≈ **8-15 min**
- P1+P3+P5 后：润色 −10-40% 且衔接无冷启动 ≈ **7-11 min**
- 叠加 P6 后：转写与润色重叠 ≈ **6-10 min**

**场景 B：1h 英文视频，whisper small + 翻译 zh-CN**（收益最大，两段都有）

- 现状：转写 6-10 min（40-60% 是 spawn/模型加载开销）+ 翻译 ~15-25 min ≈ **21-35 min**
- P1+P2+P3 后：转写 3-6 min + 翻译 12-20 min ≈ **15-26 min**
- 叠加 P4（恰有第二个任务排队）+ P6 ≈ **12-20 min**

**场景 C：多视频批量导入（队列积压）**

- 转写队列与 LLM 队列本就并行；瓶颈在 LLM 队列单并发。
- P4 后 LLM 聚合吞吐 ~1.5-1.8× → 5 个视频的翻译+润色排空时间降到 ~60-70%。

### 提升不会出现的地方（预期管理）

- 模型本身 decode 速度：计算/带宽瓶颈，以上全是消开销、减调用、做重叠，不是提速单 token；
- SenseVoice 转写速度：已是常驻 worker，基本不变（P5 仅改善衔接）；
- insight 单调用：只有 P3 的 prefill 提速，量级小；
- 生成质量上限：P1 提升的是*一致性*（减少回退到原文的 cue），不是模型能力。

### 风险复查（方案自评）

- P1：低风险高收益，纯增量、降级路径保留 → 首选；
- P2.3：收益大但触碰打包链路（新增二进制 + rpath），需走 DMG 验证；
- P4：收益依赖实测（Metal 批量解码加速比），且 ctx 对半分影响 insight，先测后定；
- P6：回滚语义复杂（部分转写失败时已产出的翻译层），放最后。
