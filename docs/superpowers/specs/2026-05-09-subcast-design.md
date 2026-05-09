# Subcast — Design Spec

> 完全本地运行的多语言字幕播放器；本文是 V1.0 的实现侧设计文档（superpowers brainstorming 流程产出）。
>
> **关联文档**：`REQUIREMENTS.md`（V1.0 功能与非功能需求 + 技术栈锁定）。本文聚焦"怎么落地"，不重写"是什么"。

**版本**：v1.0-spec
**创建日期**：2026-05-09
**下游**：本文经用户确认后，进入 superpowers `writing-plans` 流程产出实施计划

---

## 决策摘要

经过 brainstorming 一问一答确认的核心决策：

| 维度 | 选择 | 备选 / 理由 |
|---|---|---|
| **Scope** | F1-F8 全做 | 不切薄；M2 给 2-3 周完成全部 V1.0 |
| **Build Order** | Walking Skeleton 优先 | 先打通端到端最薄一刀，再回填横切关注点 |
| **Walking Skeleton 范围** | 方案 1（端到端 + `<pre>` 显示） | 1-1.5 天可达，立刻验证 Nitro + nodejs-whisper + SSE 链路 |
| **测试策略** | A 极简（关键单测 + 手测） | 不做集成 / E2E；避免极简下硬指标逼着写凑数测 |
| **架构** | 沿用 REQUIREMENTS.md 锁定的 Nuxt 4 monolith + Nitro server + SSE + SQLite + 文件系统 | 本文不重新评估 |

REQUIREMENTS.md 已经定的（**本文不再讨论**）：技术栈、目录结构、性能目标、可观测性细则、安全/隐私、i18n 策略、Network 绑定、硬件档位规则、UI 文案规范。

---

## §1 — Walking Skeleton: Slice 1 精确边界

### 验收标准

拖一个 30 秒 mp4 进 `pages/index.vue` → 页面跳到 `/player/{sha256}` → 浏览器逐行显示 SSE 推回的 cue：

```
[00:00.000-00:03.240] Hello world.
[00:03.240-00:06.500] This is a test.
...
[done]
```

### In Scope

**Server**
- `server/api/upload.post.ts` — multipart 接收，流式写入 `~/.subcast/videos/{sha256}.{ext}` 同时计算 SHA256，往 `videos` 表插一行，返回 `{ hash }`
- `server/api/transcribe.get.ts` — `?hash=...` SSE 接口，调 `nodejs-whisper`，每条 cue 通过 `data: {...}` 推回，结束发 `event: done`
- `server/utils/db.ts` — `better-sqlite3` 单例，初始化 `videos` 1 张表（schema 见 §2）
- `server/utils/ffmpeg.ts` — 流式 SHA256（`crypto.createHash` pipe）；不做音轨提取（先让 nodejs-whisper 自处理）
- `server/utils/whisper.ts` — 包一层 `nodejs-whisper`，硬编码 `model: 'base'`，吐 `AsyncIterable<Cue>`

**Client**
- `pages/index.vue` — 原生 `<input type="file">` + drop handler dropzone，上传后 `navigateTo('/player/' + hash)`
- `pages/player/[hash].vue` — `new EventSource('/api/transcribe?hash=' + hash)`，每帧 append 到一个 `<pre>`

### Out of Scope（明确不做，归到 §6 回填）

队列、缓存命中、伴生字幕检测、幻觉重试、静音段、词级时间戳、`<video>` + `<track>` 真播放器、健康面板、硬件档位自适应、翻译、i18n、Pinia、shadcn 美化、错误抽屉。

### 显式决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Whisper model | `base`（多语言） | 速度/精度折中；硬编码避开 F8 |
| 上传大小限制 | 沿用 2GB | form handler 一次性写好省事 |
| 上传时若已在转写 | HTTP 409 + UI 红字 "ALREADY_RUNNING" | walking skeleton 不引入队列 |
| 视频存储路径 | `~/.subcast/videos/{sha256}.{ext}` | 和 REQUIREMENTS.md 对齐 |
| ffmpeg 音轨提取 | 让 `nodejs-whisper` 自处理（先试） | 不行再加 `ffmpeg-static`，0.5 天回旋空间 |

### 时间预算

**1-1.5 天**。若 `nodejs-whisper` 自带音轨处理 OK，0.5 天可达 `<pre>` 看流；不 OK 加 0.5 天接 `ffmpeg-static`。

---

## §2 — 存储设计（SQLite Schema + 文件系统布局）

### 文件系统布局

```
~/.subcast/
├── videos/{sha256}.{ext}            # F1 视频拷贝（原文件可删）
├── cache/{sha256}/
│   ├── original.vtt                 # F2 转写产物
│   ├── zh-CN.vtt                    # F4 翻译产物（按 BCP-47）
│   ├── en-US.vtt
│   └── meta.json                    # 元数据汇总
├── logs/YYYY-MM-DD.jsonl            # 结构化日志（按天滚动，留 14 天）
├── data.sqlite                      # 下面 6 张表
└── tmp/                             # 上传中转、ffmpeg 临时 wav
```

### SQLite Schema（6 张表，提前在 §2 锁定，避免 §6 回填阶段反复改表）

```sql
-- 1. 视频元数据（每个 sha256 一行）
CREATE TABLE videos (
  sha256          TEXT PRIMARY KEY,
  original_name   TEXT NOT NULL,
  ext             TEXT NOT NULL,         -- mp4/mkv/...
  size_bytes      INTEGER NOT NULL,
  duration_s      REAL,                  -- 探测后回填
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER NOT NULL
);

-- 2. 转写任务（队列、断点续传都查它）
CREATE TABLE transcribe_tasks (
  id              TEXT PRIMARY KEY,      -- uuid
  video_sha       TEXT NOT NULL REFERENCES videos(sha256),
  status          TEXT NOT NULL,         -- queued|running|completed|failed|canceled
  model           TEXT NOT NULL,         -- base/small/medium/large-v3
  language        TEXT,                  -- 自动检测后回填
  total_chunks    INTEGER,
  done_chunks     INTEGER NOT NULL DEFAULT 0,
  error_msg       TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX idx_transcribe_status ON transcribe_tasks(status);

-- 3. Chunk 级落盘（断点续传 + 幻觉标记）
CREATE TABLE chunks (
  task_id         TEXT NOT NULL REFERENCES transcribe_tasks(id),
  chunk_idx       INTEGER NOT NULL,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  cues_json       TEXT NOT NULL,         -- 该 chunk 的 cue 数组
  quality         TEXT NOT NULL DEFAULT 'ok',  -- ok|suspect
  retry_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, chunk_idx)
);

-- 4. 翻译任务（独立队列，含插队 priority）
CREATE TABLE translate_tasks (
  id              TEXT PRIMARY KEY,
  video_sha       TEXT NOT NULL REFERENCES videos(sha256),
  target_lang     TEXT NOT NULL,         -- BCP-47
  status          TEXT NOT NULL,
  model           TEXT NOT NULL,         -- qwen2.5:7b 等
  progress_pct    INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 0,  -- 越大越先；用户插队时 +1000
  error_msg       TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  UNIQUE (video_sha, target_lang)
);
CREATE INDEX idx_translate_priority ON translate_tasks(status, priority DESC, created_at ASC);

-- 5. 已就绪字幕索引（VTT 在磁盘，这里建索引便于查询「该视频有哪些语言」）
CREATE TABLE subtitles (
  video_sha       TEXT NOT NULL REFERENCES videos(sha256),
  lang            TEXT NOT NULL,         -- 'original' 或 BCP-47
  kind            TEXT NOT NULL,         -- transcribed|translated|imported
  cues_count      INTEGER NOT NULL,
  completed_at    INTEGER NOT NULL,
  PRIMARY KEY (video_sha, lang)
);

-- 6. 设置（用户偏好、阈值、模型档位、调试模式...）
CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL          -- JSON 字符串
);
```

### Walking Skeleton 实际只动

- 文件系统：`videos/{sha256}.{ext}` + `data.sqlite`
- 表：仅 `videos`（不写 transcribe_tasks，因为不入队）

### 显式取舍

| 决策 | 选择 | 备选与理由 |
|---|---|---|
| `subtitles` 是表还是纯 readdir | **表** | readdir 简单但每次扫盘；表省事且可存 cues_count 等元信息 |
| `chunks.cues_json` 存 JSON 还是开 cue 表 | **JSON** | walking skeleton 需求弱，cue 不参与跨表查询；后续不够再迁 |
| 翻译插队靠 `priority` 字段还是单独 `priority_queue` 表 | **priority 字段 + 索引** | 一张表查询语义清晰 |
| 翻译子任务（30-50 条 batch 重试）落不落盘 | **不落盘**（仅 retry 计数） | 翻译比转写快很多，完整重跑可接受 |
| 数据库迁移机制 | **手写 PRAGMA user_version + if 语句** | walking skeleton 不引入 drizzle/knex |

---

## §3 — SSE 事件协议

### 连接模型

| 端点 | 用途 | 客户端 |
|---|---|---|
| `GET /api/transcribe?hash=<sha>` | 启动 / 接续转写并订阅事件流 | `new EventSource(url)` |
| `GET /api/translate?hash=<sha>&lang=<bcp47>` | 启动 / 接续翻译并订阅事件流 | `new EventSource(url)` |
| `DELETE /api/queue/transcribe/:taskId` | 取消转写（队列中或运行中） | `$fetch.delete(...)` |
| `DELETE /api/queue/translate/:taskId` | 取消翻译 | `$fetch.delete(...)` |

**两个 SSE 端点都遵循"幂等接续"语义**：
- 已存在 `running` 任务 → 附加监听，从断点续传（F2）或继续推流
- 已 `completed` → 立即从 SQLite 读出全部 cue 重放给 client，再发 `done`（让前端无需关心首次还是回访）
- 不存在任务 → 新建并开始

### 事件信封（所有 frame 共有）

```
id: <monotonic seq>
event: <type>
data: {"taskId":"...", "requestId":"...", ...event-specific...}

```

每 15 秒额外发一行 `: heartbeat\n\n`（SSE 注释帧），防本地反代或浏览器误关。

### Transcribe 事件（7 种）

| event | 何时发 | data 关键字段 | Slice 1 |
|---|---|---|---|
| `status` | 任务生命周期变更 | `status` ∈ `queued\|running\|resumed\|canceled`, `model`, `totalChunks?`, `doneChunks?` | ✅（仅 running） |
| `cue` | 每条 cue 出炉（chunk 内逐条推） | `chunkIdx`, `startMs`, `endMs`, `text`, `words?` | ✅ |
| `chunk-complete` | 一个 chunk 全部 cue 推完 + 已落盘 | `chunkIdx`, `doneChunks`, `totalChunks`, `quality` ∈ `ok\|suspect` | ⛔（slice 3+） |
| `chunk-retry` | F2 幻觉检测命中触发重试 | `chunkIdx`, `attempt` (1\|2), `reason` ∈ `repeat\|reverse-ts\|density` | ⛔ |
| `warning` | 非致命异常（模型自动降档等） | `code`, `msg` | ⛔ |
| `done` | 全部完成 | `totalCues`, `durationMs` | ✅ |
| `error` | 致命错误，连接将关闭 | `code`, `msg` | ✅ |

### Translate 事件（6 种，全部 §6 回填，slice 1 不实现）

| event | data 关键字段 |
|---|---|
| `status` | `status`, `queuePos?`, `priority`, `model` |
| `batch-progress` | `doneBatches`, `totalBatches`, `progressPct` |
| `cue-translated` | `cues: [{idx, text}]` |
| `batch-retry` | `batchIdx`, `attempt`, `reason` ∈ `count-mismatch` |
| `done` | `totalCues` |
| `error` | `code`, `msg` |

### 错误码（受控集合）

```
TRANSCRIBE_*: WHISPER_BIN_MISSING, MODEL_DOWNLOAD_FAILED, AUDIO_EXTRACT_FAILED,
              CHUNK_RETRY_EXHAUSTED, WHISPER_PROCESS_CRASHED, CANCELED, FATAL_UNKNOWN
TRANSLATE_*:  OLLAMA_UNREACHABLE, MODEL_NOT_PULLED, BATCH_RETRY_EXHAUSTED,
              CANCELED, FATAL_UNKNOWN
COMMON_*:     VIDEO_NOT_FOUND, BAD_HASH, ALREADY_RUNNING (slice 1 用),
              DISK_FULL, FS_PERMISSION
```

UI 错误抽屉展示 `code` + `msg` + `requestId` + 完整 stack。

### 显式取舍

| 决策 | 选择 | 备选 |
|---|---|---|
| cue 是逐条推还是按 chunk 批量推 | **逐条** `cue` + 一个 `chunk-complete` 收尾 | 批量延迟感更差；逐条流式体验最好且 SSE 帧本就轻 |
| 接续 / 重放是同一端点还是分开 | **同一端点幂等** | 分两个端点（`?resume=1`）会让前端复杂化 |
| 取消用 SSE close 还是单独 DELETE | **单独 DELETE** | 客户端 disconnect 也会 cleanup，但 DELETE 更可靠且能 cancel 队列中未启动的任务 |
| 翻译插队怎么触发 | **`GET /api/translate` 自带"用户主动触发"语义**（首次或重复请求都把 priority bump 到当前最高 +1） | 单独 `/promote` 端点更显式但多一个 round-trip |
| 心跳间隔 | **15s** | 30s 也可，本地无压力，15s 抗本地反代更稳 |

---

## §4 — 队列调度器抽象

### 共享接口

```ts
// server/utils/queue.ts

interface QueueTask {
  id: string;
  videoSha: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  priority: number;
  payload: unknown;
}

interface QueuePolicy {
  next(tasks: QueueTask[]): QueueTask | null;
}

class Queue<T extends QueueTask> {
  constructor(
    private name: 'transcribe' | 'translate',
    private policy: QueuePolicy,
    private worker: (task: T, signal: AbortSignal) => AsyncIterable<SseFrame>,
  );

  enqueue(task: T): void;
  cancel(taskId: string): void;                  // abort + 写 status='canceled'
  subscribe(taskId: string): AsyncIterable<SseFrame>;  // SSE handler 用
  size(): { running: number; queued: number };
}
```

**两个实例**（在 `server/plugins/00.queue.ts` 启动时创建）：
- `transcribeQueue = new Queue('transcribe', FifoPolicy, transcribeWorker)`
- `translateQueue = new Queue('translate', PriorityPolicy, translateWorker)`

### 持久化策略 — SQLite 是 Source of Truth

队列**不维护内存数组**。每次 `next()` 都查表：

```sql
SELECT * FROM transcribe_tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1;
SELECT * FROM translate_tasks  WHERE status='queued' ORDER BY priority DESC, created_at ASC LIMIT 1;
```

**好处**：
- Nitro 重启 = 队列自动恢复（`server/plugins/00.recover-tasks.ts` 把 status='running' 的旧任务统一改回 'queued'，配合 chunks 表实现 F2 断点续传）
- 没有"内存与 DB 不一致"风险
- DELETE 端点改 status 即可，无需向运行中进程发信号（worker 在 chunk 间隙轮询 status）

### 取消信号双通道

1. **DELETE 端点 → 改 SQLite status='canceled'**：worker 在 chunk 间隙 `SELECT status` 检测到就退出
2. **同时 emit AbortSignal**：让正在阻塞的 fetch（Ollama HTTP 调用）立即 abort

设计 worker 时遵守：
- 长 IO（whisper.cpp 子进程、Ollama fetch）必须挂 `signal`
- 子进程用 `child_process.spawn` + `signal: AbortSignal` 选项

### Worker 接口

```ts
async function* transcribeWorker(
  task: TranscribeTask, signal: AbortSignal
): AsyncIterable<SseFrame> {
  // 1. 查 chunks 表确定从哪个 chunk_idx 开始（断点续传）
  // 2. ffmpeg 切片 → 喂 whisper → 每条 cue yield {event:'cue', data}
  // 3. 一个 chunk 完成 → 写 chunks 表 → yield {event:'chunk-complete'}
  // 4. F2 幻觉检测命中 → yield {event:'chunk-retry'} → 重跑该 chunk
  // 5. signal.aborted 在 chunk 间隙检查 → yield 'canceled' status → return
}
```

### SSE 多订阅者

同一 `taskId` 的 SSE 端点可能被多个浏览器 tab 同时打开（F1 局域网共享）。Queue 内部为每个 running 任务维护一个 `EventEmitter`：
- Worker yield 一帧 → emitter.emit
- 每个 SSE handler 在 `subscribe(taskId)` 时拿到 EventEmitter 的 `AsyncIterable` 视图
- 新订阅者加入时**先从 SQLite 重放历史**（chunks 表里的所有 cues）+ **接着监听后续帧** = 不丢任何事件

### Walking Skeleton 简化

Slice 1 完全不引入这套抽象：

```ts
// server/api/transcribe.get.ts (slice 1)
let isTranscribing = false;
export default defineEventHandler(async (event) => {
  if (isTranscribing) throw createError({ statusCode: 409, message: 'ALREADY_RUNNING' });
  isTranscribing = true;
  try {
    return setupSse(event, transcribeOnce(hash));
  } finally { isTranscribing = false; }
});
```

抽象在 §6 Slice 3（持久化）完整引入，Slice 6（队列 UX）暴露给 UI。

### 显式取舍

| 决策 | 选择 | 备选 |
|---|---|---|
| 队列是内存数组还是 SQL 查表 | **SQL 查表** | 数组 + write-through 持久化更快但易不一致 |
| Cancel 怎么传到 worker | **DELETE 改 status + AbortSignal 双通道** | 仅靠 status 轮询会有延迟（≤ 1 chunk 才 abort）；仅靠 signal 重启后丢失 |
| 多 SSE 订阅者怎么处理 | **EventEmitter + SQLite 历史重放** | 每订阅者跑独立 worker 显然不行 |
| 队列轮询触发时机 | **事件驱动**（done/canceled 时主动 `tryStartNext()`） | 定时轮询浪费 CPU |
| Worker 异常处理 | **抛出 = `failed` + 写 error_msg + emit `error` SSE 帧** | 静默重试只在 §5 定义的可重试范围内 |

---

## §5 — 错误分类 & 重试策略

### 三级分类

| 级别 | 语义 | 任务命运 | UI 表现 |
|---|---|---|---|
| **Fatal** | 不可恢复，需用户介入 | `status='failed'` + 释放队列 | 错误抽屉（`code` + `msg` + `requestId` + 展开 stack） |
| **Retryable** | 系统可自动恢复 | 在策略内重试，超限升级为 Fatal | 进度条短暂跳红再变蓝 + 计数提示（如"chunk 12 重试中 1/2"） |
| **Warning** | 非致命异常，任务继续 | 不中断；元数据落 SQLite | 该段字幕灰边框 + tooltip / 静默 toast |

### A. F2 Whisper 幻觉重试（chunk 级）

**检测规则**（每个 chunk 转写完后跑一次）：

| 规则 ID | 条件 | 阈值（可配） |
|---|---|---|
| `repeat` | 相邻 N 条 cue text 完全一致 | N ≥ 3 |
| `reverse-ts` | 相邻 cue `startMs` 逆序 | ≥ 1 次 |
| `density` | 单 chunk cue 数 / chunk 时长（秒）> 1.5 | 仅在 chunk_duration ≥ 10s 时检测，避开短 chunk 误判 |

**重试参数升级表**：
```
Attempt 1 (原始): temperature=0.0, condition_on_previous_text=true
Attempt 2:        temperature=0.4, condition_on_previous_text=false
Attempt 3:        temperature=0.8, condition_on_previous_text=false
```

**结局**：
- 第 1 次重试通过 → 用新结果落 chunks 表，`quality='ok'`，`retry_count=1`
- 第 2 次重试通过 → `quality='ok'`, `retry_count=2`
- 全部失败 → **保留第一次结果**入库（temp=0 通常最忠实），`quality='suspect'`, `retry_count=2`，emit `chunk-complete { quality: 'suspect' }`

### B. F4 Ollama 翻译批次重试

```
Attempt 1: batch_size=40, 输出条数 != 输入 → 触发
Attempt 2: batch_size=15 (拆 3 批跑) 仍 mismatch → 触发
Attempt 3: 逐条翻 (batch_size=1) 仍 fail → 升级 Fatal: BATCH_RETRY_EXHAUSTED
```

仅"输出条数 ≠ 输入条数"触发重试。其他 Ollama 故障（HTTP 5xx / 超时）走 §C。

### C. 外部依赖故障

| 故障 | 处理 | 示例 |
|---|---|---|
| Ollama HTTP 失败 | 退避重试 3 次（500ms / 1s / 2s）→ 仍失败 → Fatal `OLLAMA_UNREACHABLE` | 翻译中途 Ollama 进程崩 |
| Whisper 子进程崩溃 | 不重试 → Fatal `WHISPER_PROCESS_CRASHED` | 罕见，多半是模型文件损坏 |
| 模型未拉取 | Fatal `MODEL_NOT_PULLED` + UI 给"拉取"按钮（调 `POST /api/models/pull`） | 启动健康检测时已经预防 |
| 磁盘满 | Fatal `DISK_FULL`（写 chunk 时 catch ENOSPC） | 缓存目录爆 |

### Warning（任务继续）

| 场景 | 表现 | 持久化 |
|---|---|---|
| 单 chunk 三次重试仍幻觉 | `chunks.quality='suspect'`，前端该段灰边框 | ✅ |
| 系统内存检测低于阈值，自动从 large-v3 降到 medium | SSE `warning { code: 'AUTO_DOWNGRADE_MODEL' }`，UI toast | settings 表更新 |
| 视频探测时长失败但转写仍可跑（duration_s 为 NULL） | UI 进度条用 chunk 数代替百分比 | 不持久化 |

### Cancel ≠ Error

用户主动取消是**正常路径**：
- DELETE 端点 → SQLite status='canceled' + AbortSignal abort
- Worker 在 chunk 间隙检测 → 发 `event: status { status: 'canceled' }` → 关闭 SSE
- **不发 `event: error`**，前端 UI 仅"已取消"灰色提示，不进抽屉

### 重启恢复

`server/plugins/00.recover-tasks.ts`：

```sql
UPDATE transcribe_tasks SET status='queued' WHERE status='running';  -- 靠 chunks 表续传
UPDATE translate_tasks  SET status='queued' WHERE status='running';  -- 翻译从头跑（快）
```

然后两个 Queue 实例 `tryStartNext()`。

### Walking Skeleton 子集

Slice 1 只实现：
- Fatal 升级（任意异常 → emit error + 关 SSE）
- 取消（虽然没队列，但 EventSource.close 时清掉 `isTranscribing` 锁）

不实现：幻觉检测、retry、warning、quality='suspect'、重启恢复。

### 显式取舍

| 决策 | 选择 | 备选 |
|---|---|---|
| F2 重试是连续 attempt 还是延迟重试 | **连续**（whisper 是 CPU 负载，等待无意义） | — |
| 幻觉检测仅在 chunk 完成后跑还是流式跑 | **仅完成后**（避免误杀正在生成的部分） | — |
| 全 chunks 重试失败时保留哪个版本 | **第 1 次**（temp=0 通常最忠实） | 保留最后一次：抖动版可能更"自然"但偏题概率高 |
| 翻译批次失败的回退是逐条还是直接放弃 | **逐条兜底**（费时但保证产物完整） | — |
| AUTO_DOWNGRADE 触发后是否记忆 | **记忆**（写 settings，下次同档位直接用降档） | 每次重新检测：用户换硬件后可手动 reset |
| Cancel 走不走 error 通道 | **不走**（语义清晰） | — |

---

## §6 — Walking Skeleton 之后的回填顺序

### 8 个回填 Slice（按依赖排序）

| # | Slice | 目标（达成 = 可演示） | 时间 | 主要交付 |
|---|---|---|---|---|
| **2** | 真播放器 + 缓存命中 | `<pre>` 替换为 `<video>` + `<track>`；同一文件再次上传 0 秒进入 | 1-1.5d | F3 base（叠加显示）、F6 base（sha 命中读 VTT）、`subtitles` 表 + `cache/{sha}/original.vtt` + `meta.json`、TextTrack `addCue` 流式累积 |
| **3** | 任务持久化 + 断点续传 | 转写到一半关浏览器/重启 Node，再打开同一视频自动从最后完成 chunk 续传 | 1.5-2d | `transcribe_tasks` + `chunks` 表、§4 队列骨架（先单任务）、§3 SSE 接续语义、`server/plugins/00.recover-tasks.ts` |
| **4** | 转写质量层 | 幻觉/异常自动重试 + 标记 suspect + 静音段提示 | 1.5-2d | §5 F2 重试参数升级、`quality='suspect'` UI 灰边框 + tooltip、静音段 ── 无语音 ── 分隔符（仅 UI 不入 VTT）、词级时间戳、JSONL 日志开始落盘 + 错误抽屉 |
| **5** | 翻译 + 字幕切换 | 选 "中文" → 滑窗翻译 → 切换零延迟 | 2d | `server/utils/ollama.ts` 滑窗翻译、`translate_tasks` 表、§5 F4 批次重试 + 逐条兜底、F5 字幕菜单、`cache/{sha}/zh-CN.vtt` 命中即 ready |
| **6** | 队列 UX + 伴生字幕 | 连传 3 个视频 → FIFO 排队；切到未翻语言 → 插队到首位；拖入带 `.srt` 文件 → 弹窗选用/重转 | 2-3d | §4 完整 Queue 抽象（双实例）、F1 任务队列 UI（队列长度/状态/取消）、F1 伴生字幕检测 + 导入弹窗（dialog）、F4 翻译插队 priority bump、模型档位 badge |
| **7** | 学习者播放器 | 0.5x-2x 倍速、字幕列表点击跳转、完整快捷键、字幕样式 | 1.5d | F3 倍速 7 档、F3 字幕列表面板（高亮 + 自动滚动 + 点击跳转）、F3 全套快捷键 + 帮助页、F3 字幕样式可调 |
| **8** | 环境引导 + 硬件自适应 | 首次启动 → 检测缺失项 → 一键命令；用户改档位下次生效 | 1.5-2d | F7 启动健康检测 + 健康面板横幅 + 各 OS 安装命令、F7 模型自动下载进度（复用 SSE）、F8 硬件探测 + 推荐档位、设置页（模型 / 缓存阈值 / 静音阈值 / 调试模式） |
| **9** | 国际化 + 抛光 + 收尾 | i18n 中英切换、shadcn 替换原生 HTML、README/DEPLOYMENT 完成、诊断包导出 | 2d | `@nuxtjs/i18n` zh-CN / en-US、ESLint 规则禁硬编码、shadcn 组件全替换、可观测性诊断包导出、局域网 IP 启动横幅、磁盘占用警示、缓存清理 UI、文档 |

**总预估**：含 Slice 1 共 **15-19 天**，吻合 M2 给的 2-3 周。

### 依赖图

```
Slice 1 → Slice 2 → Slice 3 → Slice 4 → Slice 5 → Slice 6 ──┐
                       │                                     ├→ Slice 9
                       └────────────→ Slice 8 ───────────────┤
                                                             │
              Slice 2 ──→ Slice 7 ───────────────────────────┘
```

注：Slice 7（播放器 polish）只依赖 Slice 2 的真播放器，可与 Slice 3-6 并行。Slice 8 的硬件档位可在 Slice 3 之后任意时间做。

### 关键编排原则

1. **每个 slice 结束 = 一个可演示的状态**：永远不留半截功能跨过夜
2. **Schema 提前在 §2 锁定**：任何 slice 不再加表（除非发现 §2 漏了）
3. **Observability 不集中在最后**：JSONL 日志在 Slice 4 就开始落，错误抽屉在 Slice 4 就装好；Slice 9 只做诊断包导出 + 文档
4. **i18n 留到 Slice 9**：早做的话每个 PR 都要走 `t()` 增加摩擦；晚做的话需要"批量替换硬编码"工作量大但集中可控
5. **shadcn 也留到 Slice 9**：Slice 2-8 用原生 HTML + tailwind 类名，避免组件 API 学习成本干扰核心链路
6. **Model 来源演进**：Slice 1-7 期间 Whisper model 硬编码 `'base'`（在 queue task 创建处或 upload handler）；Slice 8 引入设置页 + 硬件探测后，从 `settings` 表读取并写入新 task 的 `model` 字段。Translate 模型同理（默认 `qwen2.5:7b`）

### 显式取舍

| 决策 | 选择 | 备选 |
|---|---|---|
| 翻译先做还是队列先做 | **翻译先（S5）→ 队列后（S6）** | 反过来：队列骨架已在 S3 装好，但翻译走通后再做"双队列调度 + 插队"语义更清晰 |
| 伴生字幕检测放哪里 | **S6**（与队列 UX 一起） | S2：上传时就做。但 dialog 弹窗 + 字幕入库逻辑独立又琐碎，集中在 S6 一次做完 |
| i18n 早做还是晚做 | **晚做（S9）** | 早做摩擦大；晚做批量替换可承受 |
| shadcn 早替还是晚替 | **晚替（S9）** | 早替增加心智负担，晚替的代价是 S2-S8 的视觉粗糙 |
| 倍速/快捷键放哪里 | **S7**，不与质量层混 | 散到各 slice：会散得到处都是无法集中验收 |
| 词级时间戳放 S4 | **是** | 单独一个 slice 太薄 |
| 健康面板的"模型自动下载"能不能在 S2 做 | **不能**（需要 SSE 多事件已经稳定，等 S3） | — |

---

## §7 — 测试范围明细

按 brainstorming 第 3 问的结论 = **A 极简**：只写关键单测，不做集成 / E2E，外部依赖（whisper.cpp / Ollama）全靠手测验收。

### 单元测试范围（仅这 6 个 util）

| 文件 | 待测函数 | 关键 case | 行数估 |
|---|---|---|---|
| `server/utils/vtt.ts` | `parse(s)` / `serialize(cues)` | 多行 cue / 含 HTML tag / 时间戳格式 / 空文件 / 非 ASCII | ~80 |
| `server/utils/queue.ts` | `FifoPolicy.next()` / `PriorityPolicy.next()` | 空队列 / 同优先级按 created_at / 高 priority 抢先 / canceled 跳过 | ~50 |
| `server/utils/quality.ts` | `detectHallucination(cues, chunkDurationMs)` | repeat ≥3 / reverse-ts / density 超阈 / 短 chunk 不触发 / 干净 cue | ~70 |
| `server/utils/silence.ts` | `findSilentGaps(cues, thresholdMs)` | 间隔 = 阈值 / < 阈值 / > 阈值 / 边界 / 单 cue | ~40 |
| `server/utils/ollama.ts` 局部 | `splitIntoBatches(cues, size)` + `validateBatchOutput(input, output)` | 整除/不整除 / 输出条数不匹配 / 缺字段 | ~50 |
| `server/utils/ffmpeg.ts` 局部 | `streamSha256(stream)` | 已知 buffer 出已知 hash / 空流 | ~20 |

**总计 ~310 行测试代码**，预估投入 0.5-1 天，可分摊在各 slice 引入对应 util 时同步写。

### 工具与约定

- **框架**：`vitest`（Nuxt 默认）
- **位置**：`server/utils/__tests__/*.test.ts` 紧贴源码
- **运行**：`pnpm test`（`vitest --run`），`pnpm test:watch`（开发时）
- **数据库 fixture**：用 `new Database(':memory:')` 跑 schema migration，无需文件 IO
- **覆盖率**：**不设阈值**（极简策略下硬指标只会逼着写凑数测试）
- **CI**：**不强制**。如未来加 GitHub Actions，仅跑 `pnpm test --run` + `pnpm typecheck`

### 显式不做

| 不做 | 理由 |
|---|---|
| Vue 组件单测 | A 档极简策略；UI 改动多，单测维护成本高 |
| Nitro 端点集成测 | 涉及外部进程 mock 复杂；手测能覆盖 |
| Playwright E2E | A 档不做 |
| whisper.cpp / Ollama 真实调用 | 模型几 GB，CI 跑不动；本地手测验收 |
| F2 chunk 持久化集成 | 跨表 + 文件系统，单测拆不动；手测拔电模拟 |
| SSE 协议 fuzzing | 极简策略外 |

### 手测验收清单（每个 slice 收尾跑一遍，写进 README）

| Slice | 手测动作 | 通过标准 |
|---|---|---|
| S1 | 拖 30s mp4 | `<pre>` 出 cue 流 |
| S2 | 同一文件二次拖入 | 0 秒进播放器 |
| S3 | 转写 50% 时关浏览器 → 1 分钟后再开 | 从断点续 |
| S4 | 拖入有静音段的视频 | 静音分隔符 + 异常段灰边框 |
| S5 | 切到 zh-CN | 翻译 + 切换零延迟 |
| S6 | 连传 3 个 + 切到未翻日文 | FIFO + 日文插队 |
| S7 | 1.5x + 点字幕跳转 + `Space`/`J/L` | 行为符合 |
| S8 | 临时 stop ollama 启动 | 健康横幅出现 |
| S9 | 切 i18n + 导诊断包 | 中英切换、zip 内含日志 |

### 显式取舍

| 决策 | 选择 | 备选 |
|---|---|---|
| 测试位置 | **co-located** `__tests__/` 紧贴 util | 顶层 `tests/`：可发现性差 |
| 数据库测试 | **`:memory:`** | 临时文件：慢且要 cleanup |
| 是否引入 mock 框架 | **不引入**（vitest 自带 vi.fn 够用） | jest-mock 多此一举 |
| 是否 typecheck CI | **不强制**（用户选 A） | 推荐本地 pre-commit 跑 |

---

## 本文不重复 REQUIREMENTS.md 的内容

以下在 `REQUIREMENTS.md` 已经定义清楚，本文不再重写：

- **技术栈**：Nuxt 4 / Vue 3 / TS strict / Tailwind / shadcn-vue / `nodejs-whisper` / Ollama qwen2.5
- **目录结构**：`app/` `server/` `scripts/` `docs/` 完整树（§七）
- **架构图**：浏览器 ↔ Nitro ↔ whisper / Ollama（§五）
- **F1-F8 功能细节**：本文用 § 引用而不重述
- **非功能需求**：性能目标 / 资源占用 / 可用性 / i18n 策略 / 可观测性细则 / 安全与隐私（§四）
- **硬件档位规则表**：F8 的 4 档矩阵
- **关键依赖列表**：各 npm 包用途
- **shadcn 必备组件清单**：F1-F8 用到的 10 个组件
- **用户流程**：首次使用 / 二次访问（§六）
- **里程碑表**：M1-M5（§八）
- **风险与对策**：（§十）

---

## 下一步

经用户审阅本 spec 后，进入 superpowers `writing-plans` 流程，为每个 slice 产出可执行的 implementation plan（包含具体文件、函数签名、TDD 任务清单等）。
