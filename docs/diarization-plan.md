# 说话人识别（Speaker Diarization）方案 v1.5

> 状态：设计稿，Phase 0 spike + 用户独立验证完成
> 创建：2026-05-15 · 修订：v1.1（P0/P1 评审）→ v1.2（选型 B→A）→ v1.3（8 项 Q&A）→ v1.4（spike 后 auto-K 废除）→ **v1.5（用户验证两阶段 consolidation 管线 + UI 智能默认 + 视图切换）**
> 关联：[REQUIREMENTS.md](../REQUIREMENTS.md)、[desktop-packaging.md](./desktop-packaging.md)、[Phase 0 audit](./audits/diarization-spike-2026-05.md)、sherpa-onnx 项目的 `electron-speaker-diarization-demo/TECHNICAL_PLAN.md`

## v1.5 关键修订（用户独立验证后）

| # | v1.4 写法 | v1.5 改成 | 原因 |
|---|---|---|---|
| R8 | 算法：单阶段 sherpa.process()，依赖 auto-K + 高 threshold 收敛 | **两阶段管线**：sherpa raw → consolidation（按 raw speaker centroid 聚合 + cosine merge 到 Top-K） | 用户在自己机器上验证 25min 双人视频：sherpa raw 仍输出 11 个 speaker，无论阈值如何调；consolidation 后正确产出 speaker_A 55.9% + speaker_B 41.9% + unknown 2.2% |
| R9 | 嵌入模型 `eres2net_base` (~32 MB) | **`campplus_zh-cn_16k-common`** (~27 MB) | 用户实测 campplus 在 consolidation centroid 距离区分度上更好；同 3D-Speaker 家族，Apache 2.0 |
| R10 | sherpa 参数：threshold 0.9 / minDurationOn 0.3 / minDurationOff 0.5 | **threshold 1.0 / minDurationOn 0.5 / minDurationOff 0.8** | 用户验证：raw 阶段允许过分（不靠 threshold 收敛），让后续 consolidation 解决；min duration 长一点抑制碎片 |
| R11 | 上传 dialog 必选 K | **取消上传 dialog**，零交互上传 + 默认 Top-K=2 跑 + Player 内事后调 K（reconsolidate 1-2 秒，不重跑 sherpa） | consolidation 让 K 调整代价从分钟级降到秒级，上传时定 K 不再必要 |
| R12 | 输出 `speaker: 0/1/2` 整数 | **`speaker_A / speaker_B / unknown`** 语义标签 + `rawSpeaker` 字段保留追溯 | 用户看到的不应是 sherpa 内部 ID |
| R13 | 性能预算只覆盖 sherpa raw | 加 consolidation 阶段（~5s/25min 视频）| 第二阶段是纯 TS，瓶颈在 embedding 计算 |
| R14 | 字幕列表强制分组（Q8） | **toggle 切换**：列表视图 / 发言人视图，按 K 智能默认 + localStorage 记忆用户偏好 | 接话频繁场景分组块头爆炸 → 列表视图更密集；K=2/3 时分组更清晰 |
| R15 | 字幕面板有独立「说话人: 2」按钮 + K dropdown | **视图 toggle 按钮内嵌数字**（icon + 2）；K 改变入口移到群组块头「⋯」菜单 | UI 简洁度 + K 跟改名同入口 |
| R16 | 无 unknown 比例提示 | **unknown ≥ 15% 时顶部琥珀横条警告 + 一键「改成 N 个试试」按钮（reconsolidate）** | 用户主导改 K 的最常路径就是系统建议 |

## v1.3 决策摘要（全部仍有效）

| # | 决定 |
|---|---|
| Q1 | WAV 加载：复用 `extractWav()` 输出 + 自实现 s16→f32 归一化 |
| Q2 | 不支持中途 abort，仅 queue 级取消 |
| Q3 | speakerAssign 占比规则的分母统一用 cue 总时长 |
| Q4 | cue 拆分**只在渲染/导出层**做；cues_json 不变；新增 `chunks.speaker_timeline` JSON 列 |
| Q5 | 重跑 diarize 前弹警告 + 擦掉所有 `speakers.display_name` |
| Q6 | 新 Insights 用 speaker；已缓存的不动；通用「重新生成」按钮 |
| Q7a | `diarize_tasks` 保留 `UNIQUE (video_sha)`，retry = UPDATE 同一行 |
| Q7b | `speakers` 表 **不用** `ON DELETE CASCADE`，靠 `desktop/orphanCleanup.ts` |
| Q8 | 字幕「连续同一 speaker 合并显示头」分组渲染（**v1.5 改为发言人视图的渲染方式**，列表视图保持现状） |

## v1.5 新增 UX 决定（Q9）

| # | 决定 | 详情 |
|---|---|---|
| Q9a | 字幕面板加视图 toggle | 列表 / 发言人，icon + 当前 K 数字 |
| Q9b | 智能默认 | K=1/≥4/unknown≥15%/未跑 → 列表；K=2 或 3 → 发言人 |
| Q9c | 全局偏好 | 用户手动 toggle 后写 `localStorage[subcast.subtitleView]`，覆盖智能默认 |
| Q9d | K 改变入口 | 群组块头「⋯」菜单（重命名 / 变更说话人数 / v2 合并） |
| Q9e | 列表视图改 K | 需切到发言人视图 → 块头 ⋯。系统驱动的 K 改变（unknown 警告横条按钮）在两视图都可用 |

把"谁说了什么"加进 Subcast 的离线转写管线。完全本地，零云端调用，使用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（k2-fsa 团队，与 whisper.cpp 同梯队）的 Node 绑定 `sherpa-onnx-node`。

> ✅ **Phase 0 spike 结果**（2026-05-15，详见 [audit 报告](./audits/diarization-spike-2026-05.md)）：
>
> 1. ✅ sherpa-onnx-node v1.13.2 在 darwin-arm64 上加载通过（dev 环境；electron-builder 打包后仍待验证）
> 2. ✅ 官方测试 pack（4-speaker zh, 57s）显式 `numClusters=4` 完美；推荐阈值 0.9 也能 auto-K 出 4
> 3. ⚠️ pyannote-segmentation MIT (CNRS) 已确认；3D-Speaker ERes2Net 嵌入模型权重单独 LICENSE 仍需补查
> 4. ✅ 实测 0.122× realtime → 1h 视频约 7.3 min，与 Whisper `base` 同级，可接受
>
> 🚨 **重大发现**：auto-K 在长视频上不可靠（25min 真实视频 threshold=0.9 仍检出 37 speakers vs ground truth=2）。**v1.4 改为必填 K**，详见上面的 R1/R4。

---

## 一、技术路线选型

### 候选对比

| 方案 | 模型/库 | 集成方式 | 优缺点 |
|---|---|---|---|
| **A** | **sherpa-onnx 的 `OfflineSpeakerDiarization`** | `sherpa-onnx-node` npm 包 | 一行 API；段化 + 嵌入 + 聚类全内置；k2-fsa 团队维护模型 ONNX 化与算子兼容；prebuilt 覆盖 darwin-arm64 / win32-x64；v0.10+ 支持 streaming（未来做实时麦克风转写可复用） |
| B | 原始 ONNX 模型 + 纯 TS pipeline | 直接用 `onnxruntime-node` | 与 `vadSession.ts` 完全同构；但要自己处理 pyannote 算子兼容、聚类算法、嵌入滑窗，~500 行新代码 + 后续模型升级风险 |
| C | pyannote Python sidecar | 嵌入 Python 解释器 | 装机体积 +200MB+，违背"零外部依赖"路线 |
| D | 在线 API（AssemblyAI / Deepgram） | HTTP | 违背隐私定位，否决 |

**选定 A（sherpa-onnx-node）**。v1.1 曾选 B，被评审推翻，理由：

- 你已有 native binding（`better-sqlite3` / `onnxruntime-node` / `@ffmpeg-installer/ffmpeg`），`electron-rebuild` 流程已跑通 → 多一个 `sherpa-onnx-node` 是 N→N+1，不是 0→1
- sherpa-onnx 帮你把"pyannote ONNX 导出兼容性 + 聚类算法 + 嵌入滑窗"这三大坑全填了，Phase 0 spike 风险点从 4 项缩到 2 项
- Phase 1 实现量从 ~500 行降到 ~50 行（一个薄 wrapper）
- 模型 license 链路也由 k2-fsa 处理：他们 host 在 HuggingFace 的 model pack 内打包了已验证的开源权重 + LICENSE 文件
- sherpa-onnx 与你已用的 whisper.cpp 来自同一团队（k2-fsa），项目活跃度有保障

### 选定模型（v1.5）

**k2-fsa 官方 diarization model pack**：

| 组件 | 文件 | 大小 | 作用 |
|---|---|---|---|
| Segmentation ONNX | `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` | ~6 MB | 帧级说话人活动（pyannote-segmentation-3.0 移植） |
| Embedding ONNX | **`3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`** | ~27 MB | 说话人嵌入向量（**v1.5: campplus 替换 v1.4 的 eres2net_base**） |

合计 +33 MB，放 `binaries/models/diarization/`，走与 `silero_vad.onnx` 相同的 `extraResources` 流程。**campplus 同时用于两处**：
- sherpa 内部 `SpeakerEmbeddingExtractorConfig` 在 raw diarization 阶段
- 我们自己的 consolidation 阶段重用 `sherpa.SpeakerEmbeddingExtractor` API 算 speaker-level centroid

### 模型许可清单（已 Phase 0 验证）

| 组件 | 来源 | License | 状态 |
|---|---|---|---|
| pyannote-segmentation-3.0 (sherpa-onnx 移植) | k2-fsa HF | MIT (CNRS) | ✅ 已核对 LICENSE 文件 |
| 3D-Speaker campplus (sherpa-onnx 移植) | k2-fsa HF / modelscope | Apache 2.0 | ⏳ 单独核对（v1.4 audit 未做） |
| sherpa-onnx-node | npm | Apache 2.0 | ✅ |

AGPL-3.0 与 MIT / Apache 2.0 兼容。Phase 1 进入前更新 `NOTICES.md`。

---

## 二、Pipeline 设计

### 现状

```
upload → extractWav → detectSpeechSegments(VAD) → planChunksFromVad → transcribeChunk[i] → cues → SQLite
```

### v1.5 两阶段管线（串行）

```
upload → extractWav → detectSpeechSegments → planChunksFromVad → transcribeChunk[i] → cues (speaker = null)
                                                                                              ↓
                                                            ┌─────── diarizeWav (transcribe done 后启动) ───────┐
                                                            │                                                    │
                                                            │  Stage 1: rawDiarization                          │
                                                            │    sherpa.OfflineSpeakerDiarization.process()     │
                                                            │    config: threshold=1.0 / minOn=0.5 / minOff=0.8 │
                                                            │    output: [{start, end, speaker:int}] x N        │
                                                            │    通常 raw speaker count >> 实际                  │
                                                            │                                                    │
                                                            │  Stage 2: consolidation (新增, ~5s)               │
                                                            │    a. 按 raw speaker 聚合，计算各自 duration        │
                                                            │    b. 用 SpeakerEmbeddingExtractor 对每个          │
                                                            │       raw speaker 选 ≤24 段代表性 segment（≥0.8s） │
                                                            │       算嵌入并平均 = speaker centroid              │
                                                            │    c. 选 Top-K major speaker（默认 K=2）            │
                                                            │    d. 其余 raw speaker：                            │
                                                            │       - cosine 到 Top-K 最近 centroid ≥ 0.65       │
                                                            │         → merge 到该 speaker_A/B/...               │
                                                            │       - 否则 → mark unknown                         │
                                                            │    output: [{start, end, speaker:'speaker_A',     │
                                                            │             rawSpeaker:int}]                       │
                                                            │                                                    │
                                                            └─────────────────────────────────────────────────────┘
                                                                                              ↓
                                                                  speaker timeline (按 chunk 切片入库)
                                                                                              ↓
                                                                          SQLite UPDATE chunks.speaker_timeline
                                                                                              ↓
                                                                              SSE 单帧 diarize_done → 前端重拉
                                                                                              ↓
                                                                                  字幕面板渲染（智能默认视图）
```

**为什么两阶段**（用户独立验证）：
- sherpa 内部聚类（用 fast clustering + complete linkage）在 ≥ 5 分钟视频上不可靠，无论 threshold 怎么调
- 真实 25min 双人视频：raw 阶段输出 11 个 speaker（threshold=1.0）；任何单纯调阈值都收敛不到 2
- 用户验证 consolidation 路径：raw 11 → top-K=2 + 合并 → 最终 speaker_A 55.9% / speaker_B 41.9% / unknown 2.2%，匹配 ground truth
- 关键洞察：**K 在 consolidation 阶段决定，代价 ~1-2 秒（不重跑 sherpa）**，让 K 可以在 Player 内事后调

参考实现：sherpa-onnx 项目的 `electron-speaker-diarization-demo`（`diarize-video.js`、`consolidate-speakers.js`），v1.5 把它们移植成 TS 模块。

### Reconsolidate 路径（K 改变时）

用户在 Player 内通过群组块头 ⋯ 菜单或 unknown 警告横条按钮改 K：

```
POST /api/diarize/[hash]/reconsolidate { topK: 3 }
       ↓
  从 SQLite 读已经存的 raw segments + speaker embeddings
       ↓
  跑 Stage 2（~1-2s）
       ↓
  UPDATE chunks.speaker_timeline
       ↓
  SSE 单帧 reconsolidated → 前端重拉
```

**raw segments 和 speaker embeddings 在 Stage 1 完成时落库**，所以 reconsolidate 不需要重跑 sherpa（4-7min → 1-2s）。

关键点：

- **Phase 1 串行**：diarize 跟在 transcribe 之后启动。UI 体验是「先看到字幕（无颜色标签）→ 一两分钟后说话人标签整体出现」。
- **不做并行**：第二节早期版本写的"并行不阻塞流式"是优化目标，但 CPU 共享下并行不一定更快、且 cue 流式回填要在 SSE 通道引入乱序处理。Phase 3 再做。
- **Diarize 完成前的导出保护**：导出 API 检查 `diarize_tasks.status`，若未 done 则提示「说话人识别尚未完成，导出的字幕不含 speaker 标签」并退化为现有格式（详见第六节）。
- **Diarize 总耗时上限** ≈ wav 中**语音段**时长（VAD 输出后）的 1/8（M3）/ 1/4（旧 CPU）—— **此为目标，待 Phase 0 spike 校准**（见第八节）。Phase 0 实测若超过 Whisper `base` 同视频耗时，整套串行设计需要重审。

### 新增文件

```
server/utils/
├── diarize.ts          # 主入口：sherpa-onnx-node wrapper + WAV 加载
├── diarizeSession.ts   # sherpa-onnx OfflineSpeakerDiarization 单例（模仿 vadSession.ts 的 lazy init）
└── speakerAssign.ts    # 把 SpeakerSegment 投影到 cue 时间段（纯函数 + cue 拆分）
```

对照 v1.1 删掉 `speakerEmbed.ts` / `speakerCluster.ts` —— 这两块由 sherpa-onnx 内部完成。

### 核心数据类型

```ts
// server/utils/diarize.ts
import { OfflineSpeakerDiarization } from 'sherpa-onnx-node';

export interface SpeakerSegment {
  startMs: number;
  endMs: number;
  speakerId: number;   // 0-based, 局部于该视频
}

export interface DiarizeOptions {
  /** 说话人数。v1.4 起必填，由上传时用户选择；传 -1 走"自动检测-实验性"路径。 */
  numSpeakers: number;
  /** 仅 numSpeakers === -1（auto-K 实验性）时生效。默认 0.9（对齐 sherpa CLI 推荐）。 */
  clusterThreshold?: number;
  // 注：不提供 AbortSignal。sherpa-onnx process() 是 sync C++ 调用，
  // v1 决定不支持中途打断（见 §七）。
}

export async function diarizeWav(
  wavPath: string,
  opts?: DiarizeOptions,
): Promise<SpeakerSegment[]>;
```

注：sherpa-onnx 内部已做 VAD 等价物（onset/offset 阈值 + min duration），**不需要再把现有 VAD 的 `SpeechSegment[]` 喂进去**——会与 sherpa-onnx 自带分段冲突。

### WAV 加载（Q1 决定）

**复用现有 `extractWav()` 输出（16kHz mono s16le）+ Subcast 层 s16→f32 归一化。**

```
extractWav(srcPath, wavPath)   // 现有，不动
  └── 16kHz mono s16le WAV，已写盘到 cache

diarizeWav(wavPath)
  ├── 读 WAV file → 跳过 44 字节 RIFF header
  ├── Int16Array → Float32Array, value / 32768.0  (~20 行纯函数 readWavF32)
  └── sherpa-onnx process(samples) → SpeakerSegment[]
```

- **不引入新依赖**（不用 `node-wav` / `wavefile`）
- **`readWavF32(wavPath): Promise<Float32Array>` 单独函数 + 单测**，喂"读固定 wav 应得固定 hash"用例
- WAV 与 VAD 共用同一份 cache 文件，不增加磁盘开销

### Stage 1: sherpa raw 配置（v1.5）

`server/utils/diarize/raw.ts` 构造 `OfflineSpeakerDiarization`：

```ts
{
  segmentation: {
    pyannote: { model: '<resources>/models/diarization/segmentation.onnx' },
    numThreads: 2,
    provider: 'cpu',
  },
  embedding: {
    model: '<resources>/models/diarization/campplus.onnx',  // v1.5 改
    numThreads: 2,
    provider: 'cpu',
  },
  clustering: {
    numClusters: -1,  // v1.5: 永远 -1，让 raw 阶段自由发挥；K 由 consolidation 决定
    threshold: 1.0,   // v1.5: 不靠 threshold 收敛，consolidation 兜底
  },
  minDurationOn:  0.5,  // v1.5: 抑制碎片（v1.4 = 0.3）
  minDurationOff: 0.8,  // v1.5: 合并相邻短段（v1.4 = 0.5）
}
```

> **不再用 numClusters 控制 K**。v1.4 想用 numClusters=N 直接拿 K 个 speaker，但 sherpa 内部聚类长视频上不可靠。v1.5 把 K 决策完全交给 consolidation。

### Stage 2: Consolidation（v1.5 新增）

`server/utils/diarize/consolidate.ts`（参考用户 `consolidate-speakers.js`，~250 行 TS）：

```ts
export interface ConsolidateOptions {
  /** Top-K 模式 */
  topK?: number;        // 默认 2
  /** Auto 模式参数（topK = 0 时生效）*/
  majorSpeakerRatio?: number;  // 默认 0.05（某 raw speaker 占总时长 ≥ 5% 算 major）
  minSpeakerSeconds?: number;  // 默认 8
  /** 合并阈值 */
  mergeThreshold?: number;     // 默认 0.65（cosine 相似度，campplus 经验值）
  /** 代表性 segment 选择 */
  maxSegmentsPerSpeaker?: number;  // 默认 24
  minSegmentSeconds?: number;      // 默认 0.8
}

export interface ConsolidatedResult {
  finalSpeakerCount: number;
  rawSpeakerCount: number;
  unknownDurationS: number;
  unknownRatio: number;
  speakers: Array<{ id: string; durationS: number; ratio: number }>;
  segments: Array<{ startMs, endMs, speaker: string, rawSpeaker: number }>;
}

export function consolidate(
  rawSegments: RawSegment[],
  rawEmbeddings: Map<number, Float32Array>,  // 由 Stage 1 落库时一并算好
  opts: ConsolidateOptions = {},
): ConsolidatedResult;
```

算法详见用户 `TECHNICAL_PLAN.md` Stage 4 + `consolidate-speakers.js`。

### Speaker embedding 落库（Stage 1 → Stage 2 共享）

Stage 1 跑完后，**立即对每个 raw speaker 算 centroid embedding 落库**：

```sql
-- raw_speakers 表（新）
CREATE TABLE diarize_raw_speakers (
  video_sha       TEXT NOT NULL REFERENCES videos(sha256),
  raw_speaker     INTEGER NOT NULL,
  duration_s      REAL NOT NULL,
  segment_count   INTEGER NOT NULL,
  centroid_emb    BLOB NOT NULL,   -- f32 192-dim
  PRIMARY KEY (video_sha, raw_speaker)
);
```

这样 reconsolidate（用户改 K）就不用重跑 sherpa + embedding 提取，1-2 秒搞定。

### Speaker timeline 存储（Q4 决定）

**cues_json 不变。** 把 sherpa-onnx 输出的 `SpeakerSegment[]` 按 chunk 时间窗切片，每个 chunk 存一份到新列 `chunks.speaker_timeline`：

```ts
// chunks.speaker_timeline (JSON, nullable)
type ChunkSpeakerTimeline = {
  startMs: number;  // chunk-local-time? 否，仍是绝对时间，与 chunks.start_ms 对齐
  endMs: number;
  speakerId: number;
}[];
```

为什么按 chunk 切片：
- 与 `cues_json` 同 chunk 同行，读取一致
- chunk 是流式落盘单位，diarize 完成后批量 UPDATE 各 chunk 的 `speaker_timeline`，原子性强
- 删除单 chunk 时 timeline 跟着走，孤儿清理简单

**`cues_json` 内的 cue 对象不增字段**（兼容性最好）。speaker 信息**全部由 timeline 提供**，渲染/导出时 join。

### Speaker timeline → Cue 渲染规则（Q3 决定）

`speakerAssign.ts` 不再修改 cues_json，而是导出一个纯函数给 player/export 共用：

```ts
export function resolveCueSpeaker(
  cue: Cue,
  timeline: ChunkSpeakerTimeline,
): CueSpeakerResolution;

type CueSpeakerResolution =
  | { kind: 'single', speakerId: number, coverageRatio: number }
  | { kind: 'split',  parts: Array<{ speakerId: number; startMs: number; endMs: number }> }
  | { kind: 'none' };
```

**规则（分母统一为 cue 总时长 `cue.endMs - cue.startMs`）**：

1. 取所有与 `[cue.startMs, cue.endMs]` 相交的 `timeline` 段，按 speakerId 聚合"在 cue 内的相交时长"
2. **判 `none`**：所有 speaker 在 cue 内的相交时长之和 / cue 总时长 < 30%
3. **判 `single`**：某 speaker 单独占比 ≥ 70%，或 ≥ 2 speakers 但 dominant 占比 ≥ 70%
4. **判 `split`**：≥ 2 speakers 各自占比均 ≥ 25%
5. 其他情况（落在 30%–70% 灰区）：算 `single` 取 dominant，coverageRatio < 0.7 → UI 标低置信度

> 评审 Q3 示例：cue 5s，speaker A 0.5s + B 0.5s + 4s 空白 → `none`（总相交 20% < 30%），不会被错拆。

### Cue 拆分发生时机（Q4 决定）

**只在渲染层 / 导出层做，不在存储层做。**

| 阶段 | 行为 |
|---|---|
| diarize 完成 | UPDATE `chunks.speaker_timeline`，cues_json 不动 |
| Player 字幕列表 | 每个 cue 调 `resolveCueSpeaker`；`split` 类型在 UI 上拆成 2+ 行渲染（同一 cue_idx，渲染 key 用 `${cue_idx}-${partIdx}`） |
| VTT 导出 | 同上规则，但生成两条相邻 cue（同 cue_idx 拆成相邻时间戳，文本按标点切） |
| SearchBar / 当前 cue 高亮 | 按 cue_idx 工作，不受拆分影响 |
| 翻译已生成的双语字幕 | 双语合并时不拆，导出 `<v Dominant Speaker>原文\n译文</v>` —— 与拆分无关 |

**渲染期 cue 拆分的文本切点**（与 v1.2 的"存储期拆分"逻辑相同，只是触发时机不同）：

- **时间切点**：按 speaker timeline 真实切换时间
- **文本切点**：在切换时间对应的文本位置就近找标点（`。？！，；：、,.?!;:`），向前后各扫 ≤ 8 字符；找不到则按字符数按时长比例切
- **CJK 安全**：用 `Array.from(str)` 拆 Unicode 码点，避免 UTF-16 surrogate 切坏
- **失败回退**：切点会落在 emoji / 复合字符中间 → 放弃拆分，渲染单条 + dominant speaker，标低置信度

**为什么不在存储层拆**（评审 Q4 → 选 B 的理由）：
- 翻译流程要求"原文 cue 数 = 译文 cue 数 + 时间戳对齐"（`server/utils/vtt.ts:42-58`），存储层拆 cue 会让已有翻译全部失效
- SearchBar 等 UI 状态依赖 cue_idx 稳定
- 后续重跑 diarize 时只 UPDATE `speaker_timeline` 即可，cues_json 永不动 = 数据安全度最高

### 上传路径分支

视频上传走三条路径（对应 F1 需求的伴生字幕检测），diarize 在每条路径的接入点不同：

| 路径 | 触发 | 是否提 wav | transcribe | diarize |
|---|---|---|---|---|
| A | 仅视频文件 | ✓ | ✓ 全转写 | ✓ |
| B | 视频 + 字幕，用户选「忽略并重新转写」 | ✓ | ✓ | ✓ |
| C | 视频 + 字幕，用户选「使用现有字幕」 | ✓（**仅为 diarize**） | ✗ | 取决于设置 |

路径 C 是新增的耦合点：原本走该路径不需要 wav，加 diarize 后**强制提 wav** 才能跑识别。为避免无谓的 ffmpeg 工作 + 磁盘占用，加设置项：

- `diarization.runOnImportedSubtitles` (bool, **默认 true**)
- false 时路径 C 完全跳过 diarize，cue 不含 speaker 字段（与 v0 行为一致）

`server/api/upload.post.ts` 需对应改造：路径 C 在用户确认「使用现有字幕」后，按设置项决定是否仍 enqueue `extractWav + diarize`。

---

## 三、数据库变更（migration v11，v1.5）

```sql
-- 1. cues_json 完全不动（Q4），新增 chunks.speaker_timeline JSON 列
ALTER TABLE chunks ADD COLUMN speaker_timeline TEXT DEFAULT NULL;
-- 形状：JSON array [{ startMs, endMs, speakerId: 'speaker_A' | 'speaker_B' | 'unknown' }]

-- 2. 视频级 speaker 注册表（v1.5 修订：用语义 speakerId）
CREATE TABLE speakers (
  video_sha     TEXT NOT NULL REFERENCES videos(sha256),
  speaker_id    TEXT NOT NULL,    -- v1.5: 'speaker_A' / 'speaker_B' / ...（v1.4 是 INTEGER）
  display_name  TEXT,
  PRIMARY KEY (video_sha, speaker_id)
);

-- 3. v1.5 新表：raw speaker centroid 缓存（reconsolidate 用）
CREATE TABLE diarize_raw_speakers (
  video_sha     TEXT NOT NULL REFERENCES videos(sha256),
  raw_speaker   INTEGER NOT NULL,
  duration_s    REAL NOT NULL,
  segment_count INTEGER NOT NULL,
  centroid_emb  BLOB NOT NULL,    -- f32 192-dim, campplus 嵌入
  PRIMARY KEY (video_sha, raw_speaker)
);

-- 4. 任务级状态（Q7a：UNIQUE + UPDATE）
CREATE TABLE diarize_tasks (
  id                   TEXT PRIMARY KEY,
  video_sha            TEXT NOT NULL REFERENCES videos(sha256),
  status               TEXT NOT NULL,    -- pending/running/done/failed
  raw_speaker_count    INTEGER,          -- v1.5 新：raw 阶段输出的 speaker 数
  final_speaker_count  INTEGER,          -- consolidation 后的最终数
  unknown_duration_s   REAL,             -- v1.5 新：unknown 时长（驱动警告横条）
  unknown_ratio        REAL,             -- 0..1
  top_k                INTEGER,          -- v1.5 新：当前 consolidation 用的 K
  mode                 TEXT,             -- v1.5 新：'top_k' / 'auto'
  error_code           TEXT,
  error_msg            TEXT,
  created_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  UNIQUE (video_sha)
);
CREATE INDEX idx_diarize_status ON diarize_tasks(status);

-- 5. videos.has_diarization 状态位
ALTER TABLE videos ADD COLUMN has_diarization INTEGER NOT NULL DEFAULT 0;
```

**孤儿清理**（`desktop/orphanCleanup.ts`）：

```sql
DELETE FROM speakers            WHERE video_sha NOT IN (SELECT sha256 FROM videos);
DELETE FROM diarize_tasks       WHERE video_sha NOT IN (SELECT sha256 FROM videos);
DELETE FROM diarize_raw_speakers WHERE video_sha NOT IN (SELECT sha256 FROM videos);
```

---

## 四、API 变更

### 新增端点（v1.5）

```
GET  /api/diarize/[hash]                    → { status, finalSpeakerCount, rawSpeakerCount,
                                                 unknownRatio, topK, speakers[], timeline[] }
POST /api/diarize/[hash]/reconsolidate      → body: { topK: number | 'auto' }
                                              v1.5 新：只重跑 Stage 2，~1-2 秒
                                              不擦改名（Q5 仅 retry 时擦）
POST /api/diarize/[hash]/retry              → 整个重跑 Stage 1 + Stage 2
                                              擦 speakers / raw_speakers / timeline，UPDATE task
                                              前端先弹二次确认 dialog
PUT  /api/diarize/[hash]/speakers/:id       → 改名 { displayName }
                                              UPDATE/INSERT speakers (video_sha, 'speaker_A', '张总')
```

### Reconsolidate 实现路径（v1.5 新）

```ts
// server/api/diarize/[hash]/reconsolidate.post.ts
1. 从 SQLite 读 diarize_raw_speakers（centroid_emb + duration）
2. 从 SQLite 读所有 chunks 的 raw segments（从原 timeline 反推；或单独存表）
3. 调 consolidate(rawSegments, rawEmbeddings, { topK }) → ConsolidatedResult
4. 按 chunk 切片新 timeline，UPDATE chunks.speaker_timeline 批量
5. UPDATE diarize_tasks SET final_speaker_count=?, unknown_ratio=?, top_k=?, mode='top_k'
6. SSE 推 reconsolidated → 前端重拉
```

### 上传流程（v1.5 完全不动）

跟现在一样，零交互。`server/api/upload.post.ts` 完成 wav 提取后 enqueue 现有 transcribe task；transcribe 完成后**自动 enqueue diarize task with topK = `diarization.numSpeakersDefault`（默认 2）**。

> v1.4 想加的「几个说话人」上传 dialog 在 v1.5 取消（R11）。

### 设置项（v1.5）

`settings` 表：

- `diarization.enabled` (bool, 默认 true) —— 总开关
- `diarization.numSpeakersDefault` (int, **默认 2**) —— 自动跑时用的 K（用户事后可在 Player 内改）
- `diarization.runOnImportedSubtitles` (bool, 默认 true)
- `diarization.subtitleView` (`'auto' | 'list' | 'grouped'`，默认 `'auto'`) —— Q9c 全局偏好（同时写 localStorage，DB 为可选 sync 锚点）
- 高级（折叠）：
  - `diarization.mergeThreshold` (number, 默认 0.65) —— consolidation cosine 阈值
  - `diarization.autoMode` 三选项：majorSpeakerRatio / minSpeakerSeconds / 高级用户调

> 不再有 v1.4 的 `clusterThreshold`，因为 Stage 1 已经固定 threshold=1.0。consolidation 的 `mergeThreshold` 才是用户可调的语义。

---

## 五、UI 变更

### 字幕列表分组渲染（Q8 决定）

**连续同一 speaker 的多个 cue 合并为分组块**，speaker 头只显示一次：

```
▼ 说话人 1                     ← 分组头，固定色块 + display_name
  01:23  今天我们来讨论本地大模型
  01:25  目前看 Qwen 是首选

▼ 说话人 2
  01:27  我同意，开源模型已经够用了
```

实现：

- 渲染时把 cue 数组遍历，**相邻同 speaker 合并为 group**；`resolveCueSpeaker` 返回 `split` 的 cue 会在拆分后参与分组
- speaker 头是粘性 / sticky 的：滚动时当前 group 头吸顶（学 Slack 的 day 分组）
- 单 speaker 整段视频 → 仍显示一次分组头，避免用户疑惑「我开了 diarize 但没看到任何标签」
- 点击 speaker 头 → 改名输入框，写回 `speakers.display_name`
- speaker 颜色：HSL 色环按 **实际出现的 speaker 顺序** 映射到色环索引（不直接按 speaker_id），避免合并/重跑后跳色

### 播放器叠加层

字幕底部叠加可选显示当前说话人（设置项 toggle）。叠加层只显示 dominant speaker 名字，**不做 split 拆分**（叠加层文本是 HTML5 `<track>` cue 文本，VTT 标准 `<v>` 标签的跨浏览器渲染不稳定，叠加层走纯文本最大兼容）。

### Insights 集成（Q6 决定）

`app/components/InsightsPanel.vue`：

- **新视频**（diarize 已完成 + 用户首次生成 Insights）：prompt 自动加 speaker 前缀（"说话人 1: ...\n说话人 2: ..."），模板换成「多人对话场景」
- **已有 Insights 缓存**：保持原样，不自动作废
- **加一个通用"重新生成"按钮**：始终可点，逻辑是 `DELETE FROM insight_tasks WHERE video_sha=? AND ui_language=?` 然后跑新一轮。**这个按钮同时承担 diarize 升级的入口**（不是 diarize 专属按钮）
- UI tooltip：「重新生成将使用最新的字幕、说话人信息和最新的 LLM 模型」

### v1.5 字幕面板 UI（核心修订，详见 `.cache/mockup-diarize-ui.html` + `mockup-diarize-toggle-v2.html`）

#### 面板 header

```
┌─────────────────────────────────────────────────────┐
│ 字幕 · 中文                  [☰ list][👥 2 grouped] │
└─────────────────────────────────────────────────────┘
```

- **视图 toggle**：`☰` 列表 / `👥 + 当前 K 数字` 发言人，segmented control 风格
- 当前 K 数字纯显示（不开下拉），K 改在群组块头里

#### 智能默认视图（Q9b）

```ts
function smartDefault(r: DiarizeResult): 'list' | 'grouped' {
  if (!r || r.finalSpeakerCount <= 1) return 'list';
  if (r.unknownRatio >= 0.15) return 'list';
  if (r.finalSpeakerCount <= 3) return 'grouped';
  return 'list';
}

function effectiveView(r, userPref) {
  if (userPref === 'list' || userPref === 'grouped') return userPref;
  return smartDefault(r);  // userPref === null（未碰过 toggle）
}
```

- `localStorage[subcast.subtitleView]` 三态：`null` / `'list'` / `'grouped'`
- 用户手动 toggle → 写入全局偏好，覆盖智能默认

#### 列表视图（默认）

跟现有 Subcast 一样的密集时序流，每行最左加 speaker 小芯片（A 蓝点 / B 紫点 / unknown 灰点）。

#### 发言人视图

连续同一 speaker 的 cue 合并块，块头：

```
┌────────────────────────────────────────────┐
│ 🔵 说话人 A    55.9% · 7:01           [⋯]  │
├────────────────────────────────────────────┤
│   [00:03] 大家好，今天我们...              │
│   [00:06] 首先看 Qwen 2.5 的几个版本…      │
└────────────────────────────────────────────┘
```

- 块头 sticky 滚动（滚到下一块前一直吸顶）
- 单 speaker 整段视频 → 自动塌缩，不显示分组头，面板 header 加「单人独白」徽章
- speaker 颜色：HSL 色环按实际出现顺序映射（合并/重跑不跳色）

#### 群组块头「⋯」菜单（Q9d）

点 ⋯ 弹菜单：

```
┌─────────────────────┐
│ 重命名         ↵   │
│ 合并到其他说话人 ›  │ ← v2，v1 灰显
├─────────────────────┤
│ 变更说话人数        │
│   1 (单人)          │
│ ✓ 2 (默认)          │
│   3                 │
│   4                 │
│   自动检测          │
└─────────────────────┘
```

选 K → 调 `POST /api/diarize/[hash]/reconsolidate { topK }`，1-2 秒后 SSE 推 `reconsolidated`，前端重拉新 timeline。

#### Unknown 警告横条（Q9e + R16）

当 `unknown_ratio >= 0.15` 时，面板顶部琥珀横条（两个视图都显示）：

```
⚠ 18% 内容（4分32秒）未能确信归属任何说话人      [改成 3 个说话人试试 →]
```

按钮直接 `POST reconsolidate { topK: currentK + 1 }`，是用户主导改 K 的最常入口。

#### diarize 跑中状态

面板 header 显示 spinner「识别说话人中…」+ toggle disabled。字幕仍按列表视图正常显示，等完成后自动应用智能默认。

### 重命名交互（Q5）

- 群组块头点 ⋯ → 重命名
- inline input：

```
🔵 [张总________________]  Enter 保存 · Esc 取消
```

- 写回 `speakers (video_sha, 'speaker_A', '张总')` UPSERT
- 字幕区显示「张总: ...」，导出 SRT/VTT 也带 display_name

### 设置页（`app/pages/settings.vue`）

新区块「说话人识别」：

- 启用开关 (`diarization.enabled`) —— 总开关
- 默认说话人数（1 / **2** / 3 / 4 / 自动检测-实验性）—— 上传后自动跑用的 K
- 字幕视图：**跟随说话人数（推荐） / 始终列表 / 始终发言人** —— 三选项写 `localStorage[subcast.subtitleView]`（null/list/grouped）
- 「在伴生字幕导入时也跑识别」(`diarization.runOnImportedSubtitles`)
- 高级（折叠）：
  - `mergeThreshold` 0.4-0.85 滑块，默认 0.65
  - majorSpeakerRatio（Auto 模式）滑块
  - minSpeakerSeconds（Auto 模式）滑块
- 「重跑当前视频的说话人识别」按钮 —— 弹窗：「重跑会重新跑底层模型（~5min），擦掉所有改名。如果只想试不同的说话人数，可以直接在播放页群组块头点 ⋯」+ K 选择器
- **不提供"重跑整库"批量按钮**

---

## 六、导出格式

> Q4 提醒：导出时**一次性应用 cue 拆分**（与渲染同款 `resolveCueSpeaker` 逻辑），cues_json 本身不变。导出前检查 `diarize_tasks.status`，未 done 时不输出 speaker 标签 + UI 提示「说话人识别尚未完成」。

### VTT

用 WebVTT 标准的 `<v>` 标签。Cue 拆分时输出两条相邻时间戳：

```vtt
00:01:23.000 --> 00:01:25.000
<v 说话人 1>今天我们讨论这个问题。

00:01:25.000 --> 00:01:27.000
<v 说话人 2>我同意你的看法。
```

> `<v>` 是 W3C WebVTT 标准但 player 端 CSS 渲染兼容性参差。**Subcast 自己的 player 不依赖 `<v>` 着色，颜色由 DOM 渲染层控制**。`<v>` 仅用于外部 player（VLC / mpv / IINA 等）。

### SRT

SRT 无标准 speaker 字段，**用 `display_name:` 前缀**（拆分时输出多条）：

```srt
1
00:01:23,000 --> 00:01:25,000
说话人 1: 今天我们讨论这个问题。

2
00:01:25,000 --> 00:01:27,000
说话人 2: 我同意你的看法。
```

### TXT

```
[说话人 1] 01:23  今天我们讨论这个问题。
[说话人 2] 01:25  我同意你的看法。
```

### Bilingual VTT

双语**不拆 cue**（拆译文风险大，见 §二 "Cue 拆分发生时机"），输出 dominant speaker：

```vtt
00:01:23.500 --> 00:01:27.800
<v 说话人 1>今天我们来讨论本地大模型
Today we're discussing local LLMs</v>
```

### Export Dialog

`app/components/ExportDialog.vue` 加一个 checkbox「包含说话人标签」（默认开）：

- 关掉时退化为现有格式（无 speaker 前缀）
- 字幕显示名称使用 `speakers.display_name`（若有），否则 i18n 默认「说话人 N」/「Speaker N」

---

## 七、边界与质量

### 边界情况

| 场景 | 处理 |
|---|---|
| 整段单人独白 | sherpa-onnx 输出 1 个 speaker，UI 显示低调"单人"徽章而不隐藏（避免用户以为没识别） |
| 视频开头有背景噪声/音乐 | sherpa-onnx 内部 `minDurationOn/Off` 已过滤；不需要外部 VAD 预处理 |
| 重叠说话 | sherpa-onnx 当前版本输出可能合并到 dominant；overlap 标注作 v2 优化 |
| 说话人极短发言（"嗯""对"） | sherpa-onnx 内部 `minDurationOn = 0.3s` 默认会丢弃；过短发言归入相邻 speaker |
| 用户后期发现误判 | 提供「合并 Speaker A → B」按钮，重写 cues_json |

### 质量门

- 给 cue 加可选 `speakerConfidence: number`，目前从 cue 拆分场景推得（dominant 占比）；sherpa-onnx 当前版本不导出 per-segment 置信度，待版本升级
- UI 在 `speakerConfidence < 0.6` 时给灰色 speaker 标签 + tooltip「识别置信度低」
- 单元测试覆盖 `speakerAssign.ts` 的纯函数（cue 拆分逻辑、占比分支）；`diarize.ts` 走集成测试（喂固定 wav 验证段落数 + 切换点 ±200ms 误差）

### 失败回退

- sherpa-onnx 加载失败（模型缺失 / native binding 平台不匹配）→ 不影响转写，任务标 failed + `error_code = 'DIARIZE_LOAD_FAILED'`，UI 拉横条「说话人识别不可用」+ 一键重试
- 处理过程中 OOM（极少见，sherpa-onnx 流式内部处理）→ `error_code = 'DIARIZE_OOM'`，提示用户分段处理或关闭功能
- 用户禁用 (`diarization.enabled = false`) → 完全跳过 task，`chunks.speaker_timeline` 保持 NULL
- **不支持中途 abort**（Q2 决定）：sherpa-onnx `process()` 是 sync C++ 调用没有中断接口。已开始跑的 diarize 任务跑完为止；只能取消"等待中"的任务。用户关闭应用后后台仍可能跑 ~1-2 分钟，落盘后退出

---

## 八、性能预算（v1.5 实测）

测试基线：用户真实视频 25min 双人对话（`091160797f56c44738538cd11c6612c0.mp4`），M3 MacBook Air：

| 阶段 | 25min 实测 | 1h 外推 |
|---|---|---|
| VAD | ~7 s | ~15 s |
| Whisper `base` 转写 | ~2.5 min | ~5 min |
| **Stage 1**: sherpa raw diarize（v1.5 config） | ~3 min | ~7 min |
| **Stage 2**: consolidation（embed Top-N raw speaker centroid + cosine merge） | ~5 s | ~10 s |
| Speaker → cue 投影 + 拆 cue | < 1 s | < 1 s |
| **首次墙钟（含 transcribe + diarize 串行）** | ~5-6 min | **~12-13 min** |
| **Reconsolidate（用户改 K）** | **~1-2 s** | **~2-3 s** |
| 额外 RAM 峰值 | +200 MB | +200 MB |
| 额外磁盘 | +33 MB 模型 + ~30 MB native binding（一次性） | 同左 |
| centroid 缓存（diarize_raw_speakers 表） | ~5 KB/视频 | ~10 KB/视频 |

**关键 UX 数字**：
- 首次跑 diarize：等的是 transcribe（~5min/h），diarize 顺路出
- **用户改 K**：从分钟级降到 **1-2 秒**（v1.4 必须重跑）—— v1.5 最大的 UX 改进
- Stage 2 是纯 TS + 几十次 embedding 调用，瓶颈在 embedding 提取速度

> **K=5 异常 vs v1.5**：v1.4 spike 时 sherpa numClusters=5 出现过 14× 性能悬崖。v1.5 永远传 numClusters=-1，避开了这条路径。Stage 2 不调 sherpa 聚类，只走自己的 cosine 合并，无此风险。

---

## 九、分阶段交付

### Phase 0（强前置 spike，~1 天）

**未完成不得进入 Phase 1**。任一项失败 → 方案需重审：

1. `pnpm add sherpa-onnx-node` + `pnpm rebuild` 在 darwin-arm64 上跑通；electron-builder 打包后能加载（与 `better-sqlite3` 同流程）
2. 下载 k2-fsa 官方 diarization model pack 到 `binaries/models/diarization/`
3. `scripts/spike-diarize.mjs`：自录 1 分钟双人对话 wav，喂 `OfflineSpeakerDiarization.process()`，验证：
   - 输出段落数与人耳听到的轮次一致（±1）
   - 切换点误差 < 200ms
4. 实测 1h 真实视频 diarize 总耗时，对比 Whisper `base` 耗时
5. 核对 model pack 内 LICENSE 文件，写入 `NOTICES.md`
6. spike 报告落到 `docs/audits/diarization-spike-2026-05.md`

对比 v1.1 删掉的 spike 项：ONNX 算子兼容性、聚类阈值校准、嵌入区分度 —— 这些由 sherpa-onnx 内部保证。

### Phase 1（MVP，~5-7 天，v1.5 更新）

**server/utils/diarize/**（新目录，分模块）：

- `extractAudio.ts`（~10 行）：直接复用现有 `extractWav()`，确认 16kHz mono s16le
- `rawDiarization.ts`（~120 行）：sherpa OfflineSpeakerDiarization wrapper + `readWavF32`
  - 跑完后**额外**对每个 raw speaker 选代表性 segment、过 SpeakerEmbeddingExtractor 算 centroid → 落 `diarize_raw_speakers`
- `consolidate.ts`（~250 行，参考用户 `consolidate-speakers.js` 移植）：
  - Top-K 模式 + Auto 模式（majorSpeakerRatio）
  - 合并阈值 cosine
  - 输出 `{ speaker_A/B/..., unknown }`
- `speakerAssign.ts`（~150 行，v1.4 已规划）：cue 投影 + 拆 cue（标点切点 / CJK 安全）
- `diarize.ts`（~80 行）：主入口，串联 extractAudio → rawDiarization → consolidate → speakerAssign → 落 timeline

**shared/diarization.ts**（~30 行）：`CueSpeakerResolution` / `groupCuesBySpeaker` / 智能默认视图函数

**migration v11**（详见 §三）：5 张/列改动

**API**：
- `GET /api/diarize/[hash]` 状态
- `POST /api/diarize/[hash]/reconsolidate`（v1.5 新，1-2 秒）
- `POST /api/diarize/[hash]/retry`（重跑完整管线）
- `PUT /api/diarize/[hash]/speakers/:id` 改名

**`desktop/orphanCleanup.ts`** 加 3 张表 cleanup SQL

**前端**：
- `app/components/SubtitlePanel/`（拆开现有逻辑）
  - `ViewToggle.vue` —— 视图切换按钮（icon + 数字）
  - `ListView.vue` —— 列表视图（行内小芯片）
  - `GroupedView.vue` —— 发言人视图 + 块头 ⋯ 菜单
  - `SpeakerHeaderMenu.vue` —— 块头下拉（重命名 / 变更说话人数）
  - `UnknownWarningRibbon.vue` —— 警告横条 + 改 K 按钮
- `useSubtitleView()` composable —— 智能默认 + localStorage 持久化
- `app/components/ExportDialog.vue` 加「包含说话人标签」勾选
- `app/pages/settings.vue` 加「说话人识别」区块
- i18n：speaker_A → "说话人 A" / "Speaker A" 翻译表 + 各种文案

**timeout 兜底**：Stage 1 跑超 2× 预算自动 kill，task failed。

**总工程量**：v1.5 比 v1.4 多 consolidate + reconsolidate + view toggle + UI 抽组件，估 ~5-7 天。
- `server/api/diarize/[hash].get.ts` + `retry.post.ts`（body 收新 K）+ `speakers.put.ts`
- `desktop/orphanCleanup.ts` 加 2 行 cleanup SQL
- `server/api/upload.post.ts`：从请求体读 `numSpeakers` 透传到 diarize task
- 上传 dialog（v1.4 新增，R4）：`app/components/UploadDialog.vue` 加"几个说话人"选择器
- `app/pages/player/[hash].vue` 字幕列表 Q8 分组渲染 + speaker 改名 dialog
- `app/components/ExportDialog.vue` 加「包含说话人标签」勾选
- `app/pages/settings.vue` 加「说话人识别」区块（含高级折叠区的 clusterThreshold）
- VTT/SRT/TXT 导出 + 「重新生成 Insights」通用按钮
- **timeout 兜底**：sherpa-onnx process 调用超 2× 预算自动 kill 并标 task failed（K=5 偶发性能悬崖防御）

### Phase 2（~3 天）

- 改名 + 合并 speaker
- Insights prompt 集成
- 重跑已有视频按钮

### Phase 3（v1.1）

- 与转写**并行**（Phase 1 串行已够用）
- 跨视频说话人推荐（基于 centroid embedding）—— 这是 `speakers.embedding` 那一列的真正用途

### Phase 4（v2，按需）

- "我的家人/同事"声纹库（用户主动注册）→ 自动命名而非 Speaker 1/2
- 完全打开 reference embeddings 跨视频识别

---

## 十、风险与决策点

| 决策 | 推荐 | 备选 |
|---|---|---|
| sherpa-onnx-node 平台覆盖 | 仅打包 darwin-arm64 + win32-x64（与 Subcast 现有发布矩阵对齐） | 加 darwin-x64 / linux-x64（多~30MB×N，按用户报告再上） |
| ONNX 模型分发 | `extraResources` 内嵌进 dmg（+36MB） | 首次使用时下载（保持 dmg 体积，但与 Silero VAD 现有模式不一致） |
| 默认开关 | 默认开（用户在设置里可关） | 默认关，引导上首次使用打开 |
| 聚类阈值 | sherpa-onnx 默认 0.5，仅"高级设置"暴露 | 普通设置项暴露（噪声大，多数用户用不到） |
| 已有视频迁移 | 按需，用户在设置点按钮 | 后台自动扫描全部回填（耗资源） |
| native binding 升级 | 跟 Subcast 版本绑定测试，每次升 sherpa-onnx-node 都跑 Phase 0 spike 1-3 项 | 自动升级（风险：算子兼容回归没人发现） |

---

## 十一、下一步

**唯一路径：Phase 0 spike 先行。**

具体动作：

1. `pnpm add sherpa-onnx-node` —— 先在 dev 环境验证安装不报错
2. 跑 `pnpm rebuild` + 触发一次 `pnpm dev:desktop`，确认 electron 能加载该 native module
3. 从 [k2-fsa 官方 model pack](https://github.com/k2-fsa/sherpa-onnx/releases) 下载 segmentation + embedding 两个 ONNX，放 `binaries/models/diarization/`
4. 写 `scripts/spike-diarize.mjs`：
   - 加载两个模型构造 `OfflineSpeakerDiarization`
   - 喂自录 1 分钟双人对话 wav（中文 + 英文混合）
   - 输出 `{ segments: [{start, end, speaker}], elapsedMs }`
5. 测试矩阵：
   - 单人独白（应输出 1 个 speaker）
   - 双人均衡（应输出 2 个 speaker，切换点误差 < 200ms）
   - 双人短接话（A→B 间隙 < 500ms，验证 sherpa-onnx 是否能分出来 → 影响后续 cue 拆分必要性）
6. 实测 1h 真实视频 diarize 耗时 vs Whisper `base` 耗时
7. 核对 model pack 内 LICENSE，更新本文档"模型许可清单"小节
8. 写 `docs/audits/diarization-spike-2026-05.md` 记录耗时 / 内存 / license 实测结果
9. 通过后进入 Phase 1（`server/utils/diarize.ts` + `diarizeSession.ts` + `speakerAssign.ts` + migration v11）

Phase 0 失败的常见预案（按发生概率）：

- sherpa-onnx-node prebuilt 在 darwin-arm64 加载失败 → 提 issue + 临时回退到 v1.1 的纯 ONNX 方案（B），Phase 0 spike 时长翻倍
- model pack 内 LICENSE 实际为 NC → 提 issue 给 k2-fsa 询问替代 pack；同时找 `revai/reverb-diarization` 备选
- 耗时超过 whisper `base` → 取消第二节"串行"设计，Phase 1 范围扩大到包含 Phase 3 的并行调度
