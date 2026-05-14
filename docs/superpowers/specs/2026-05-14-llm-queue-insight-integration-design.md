# Subcast — LLM Queue / Insight Integration Design Spec

> 把 AI 总结（insight）任务纳入与翻译共享的 LLM 队列，实现首页任务面板可见性 + 跨任务 llama-server 资源协调。
> 本文为 superpowers brainstorming 流程产出。下游：`writing-plans` 生成实施计划。

**版本**：v1.0
**创建日期**：2026-05-14
**关联**：
- `docs/superpowers/specs/2026-05-09-subcast-design.md`（V1.0 主设计）
- `docs/superpowers/specs/2026-05-12-ai-insights-design.md`（insight 原始设计；本文是其后续整合）

---

## 决策摘要

经一问一答 brainstorming 确认：

| 维度 | 选择 | 否决项 / 理由 |
|---|---|---|
| **队列范围** | `LLMQueue` 合并 translate + insight；transcribe 独立 | 三合一队列让转写无谓排队（whisper 与 llama 不抢资源） |
| **并发模型** | 单 worker，FIFO（按 `created_at`）跨两张表 | priority 字段当前不引入；如实测 insight 老等再升级 |
| **SSE 行为** | 立即建立连接，先推 `status: 'queued'` 事件，worker 启动后无缝转 token 流 | 不返回 task_id 让前端轮询切换；不用 503 拒绝 |
| **去重** | 入队前查 `(video_sha, ui_language)`，命中已 queued/running/done → attach 现有任务 | 不每次新建任务；不引入跨语言/跨模型缓存 |
| **任务结果持久化** | 沿用现有 `insights.json` 文件 + DB status 行 | 不新增 `result_json` 列；不重新设计存储 |
| **取消** | 永不自动取消（即使所有订阅者断开）；显式 `DELETE /api/queue/insight/[id]` | 不引用计数取消；切走再回来仍能看到完整结果 |
| **优先级** | FIFO，translate 和 insight 平权 | 不区分类型加权；不抢占 active 任务 |
| **Schema** | 不动 —— `insight_tasks` v7 + `insights.json` 已够用 | 不新增字段；不改文件格式 |

---

## §1 — 范围与文件清单

**新增**

| 路径 | 类型 | 职责 |
|---|---|---|
| `server/api/queue/insight/[id].delete.ts` | API | 显式取消 insight 任务（统一队列取消接口） |

**修改**

| 路径 | 改动 |
|---|---|
| `server/utils/queue.ts` | 新增 `LLMQueue` 类（合并 `TranslateQueue` + insight worker），导出 `llmQueue` 单例。`translateQueue` 导出仍存在，但改为 thin facade —— `ensureTask` / `cancel` / `bumpPriority` / `attach` 等 translate-语义方法委派到 `llmQueue` 上对应的内部方法（保留是为了不改散落的调用点） |
| `server/utils/insightTasks.ts` | 拆出纯函数 `runInsightWorker(active, params)` 给 `LLMQueue` 调用；移除 in-memory `tasks` Map 和 `void runGeneration()` 入口；继续依赖 `server/utils/insights.ts` 的 `parseInsights` / `snapChapters` |
| `server/api/insights.get.ts` | 改为 `ensureInsightTask(hash, uiLang)` → `llmQueue.attach(taskId)` 中转 SSE；保留 `insights.json` 文件 cache-hit 短路径 |
| `server/api/insights/[id].delete.ts` | 改为单行代理 `return { ok: true, aborted: llmQueue.cancel(id) }`；现有兜底 DB 更新逻辑收进 `llmQueue.cancel` |
| `server/api/queue/list.get.ts` | 加 `kind: 'insight'` 分支，从 `insight_tasks` LEFT JOIN videos 取行，按 `created_at` 合并到 items 数组 |
| `server/plugins/00.queue.ts` | `await translateQueue.tryStartNext()` → `await llmQueue.tryStartNext()`；更新顶部注释（不再只提 translation） |
| `server/plugins/02.recover-zombie-tasks.ts` | boot 后改为 `await llmQueue.tryStartNext()`（替换原 `translateQueue.tryStartNext()`） |
| `server/api/desktop/shutdown.post.ts` | 删除 `abortAllInsightTasks()` 调用 + import；`Promise.all([transcribeQueue.cancelActive(), translateQueue.cancelActive()])` → `Promise.all([transcribeQueue.cancelActive(), llmQueue.cancelActive()])`；返回值的 `abortedInsights` 字段保留为兼容（值为 0 或从 cancel 结果推断） |
| `server/api/transcribe/retry.post.ts` | `getTaskByHash(hash)` + `abortTask(...)` → 改为 DB 查询 `insight_tasks WHERE video_sha=? AND status IN ('queued','running')` + `llmQueue.cancel(id)` 循环 |
| `server/api/cache/list.get.ts` | `getTaskByHash(r.sha256)?.status === 'running'` → 改为 DB 查询 `EXISTS (SELECT 1 FROM insight_tasks WHERE video_sha=? AND status IN ('queued','running'))` |
| `server/api/cache/[hash].delete.ts` | `getTaskByHash + abortTask` → 同上，DB 查询 + `llmQueue.cancel` |
| `server/utils/__tests__/queue.test.ts` | 现有 translateQueue 测试通过 thin facade 继续可用；**新增** `LLMQueue` 跨任务类型 FIFO 测试 + `ensureInsightTask` 去重 + resurrection 测试 |
| `app/pages/index.vue` | 任务面板加 `v-else-if="item.kind === 'insight'"` 渲染分支；取消按钮加 insight 分支 |

**删除**

| 路径 | 原因 |
|---|---|
| `server/utils/insightTasks.ts` 中的 `tasks: Map<string, InsightTask>`、`startTask()`、`abortTask()`、`abortAllInsightTasks()`、`scheduleEviction()`、`getTaskByHash()`、`getTaskById()` | 由 `LLMQueue` + DB 查询取代；保留文件作为 `runInsightWorker` 的存放点 |
| `InsightTask` 接口（in-memory 形态） | 不再存在；调用点直接用 DB 行 `InsightTaskRow` 类型 |

---

## §2 — 架构

```
┌─────────────────────────────────────────────────┐
│ TranscribeQueue (whisper.cpp，独立 worker)      │ ← 不变
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ LLMQueue (llama-server，单 worker)              │
│                                                 │
│  active: { taskId, kind, emitter, abort,        │
│            donePromise } | null                 │
│                                                 │
│  tryStartNext():                                │
│    SELECT id, 'translate' AS kind, created_at   │
│      FROM translate_tasks WHERE status='queued' │
│    UNION ALL                                    │
│    SELECT id, 'insight' AS kind, created_at     │
│      FROM insight_tasks WHERE status='queued'   │
│    ORDER BY created_at ASC LIMIT 1              │
│                                                 │
│    → if kind === 'translate': runTranslate(...) │
│    → if kind === 'insight':   runInsight(...)   │
└─────────────────────────────────────────────────┘
```

**关键不变量：**

- llama-server 任意时刻最多 1 个 generation in-flight
- `LLMQueue.active` 为单个 slot；类型为可辨识联合（discriminated union by `kind`）
- 现有 `TranslateQueue.runWorker` 体内逻辑原样搬到 `LLMQueue.runTranslateWorker`
- `insightTasks.ts` 的 `runGeneration` 体内逻辑搬到 `LLMQueue.runInsightWorker`，签名改为接收 `ActiveLLMTask` + `InsightWorkerParams`
- `attach(taskId)` 单一入口，根据 task 是哪张表的行分发到对应的协议（translate 协议 / insight 协议各自独立）

**复用：**

- 现有 SSE 协议两套都不动（translate 的 `status/cue-translated/batch-progress/done/error`；insight 的 `start/token/done/error`）
- worker 完成 / 失败 / 取消后 `tryStartNext()` 自动起下一个

---

## §3 — API 与 SSE

**端点表：**

| 方法 | 路径 | 改动 |
|---|---|---|
| GET | `/api/insights?hash=...` | 改为 ensureInsightTask + llmQueue.attach 中转；SSE 协议加 `event: status data: {status: 'queued'}` 帧 |
| DELETE | `/api/insights/[id]` | 代理到 `llmQueue.cancel(id)`；保留以兼容现有前端调用 |
| DELETE | `/api/queue/insight/[id]` | 新增；语义同上，作为统一队列取消接口 |
| GET | `/api/queue/list` | 返回 items 加入 insight 形态（见下） |
| DELETE | `/api/queue/translate/[id]` | 不变（内部已是 `translateQueue.cancel` → 改为 `llmQueue.cancel`） |
| DELETE | `/api/queue/transcribe/[id]` | 不变 |

**`/api/queue/list` 返回 insight 形态：**

```ts
{
  kind: 'insight',
  id: string,
  videoSha: string,
  videoName: string,
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled',  // 沿用 insight_tasks 词表
  model: string,
  progressPct: 0,                  // 二态：未完成 0，done 后由前端按 status 渲染
  uiLanguage: 'zh-CN' | 'en',
  createdAt: number,
  errorMsg: string | null,
}
```

**新 SSE 事件 `status` 定义（在 `/api/insights` 上）：**

```
event: status
data: {"taskId": "...", "status": "queued" | "running"}
```

- 客户端 SSE 一连上立即收到 `start`（已有）+ `status`（新）
- worker 实际 dequeue 时再推一次 `status: 'running'`
- 现有客户端没有 `addEventListener('status', …)` → 该事件被 `EventSource` 静默丢弃，不影响 `start/token/done/error` → 向前兼容

**取消行为：**

- `DELETE /api/queue/insight/[id]` 调 `llmQueue.cancel(id)`：
  - DB UPDATE status='canceled'
  - 如果是当前 active.taskId → `active.abort.abort()`
  - 返回 `{ ok: true }`
- HTTP 客户端断开（用户关 panel） → SSE handler 只 `cleanup()` 解 listener，**不**触发 cancel

---

## §4 — 数据模型

**`insight_tasks` schema（v7，不变）：**

```sql
CREATE TABLE insight_tasks (
  id            TEXT PRIMARY KEY,
  video_sha     TEXT NOT NULL REFERENCES videos(sha256),
  status        TEXT NOT NULL,    -- queued|running|done|error|canceled
  model         TEXT NOT NULL,
  ui_language   TEXT NOT NULL,
  error_msg     TEXT,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  UNIQUE (video_sha, ui_language)
);
CREATE INDEX idx_insight_status ON insight_tasks(status);
```

唯一约束 `(video_sha, ui_language)` 天然提供去重。

**结果文件（不变）：**

`{cache}/{hash}/insights.json` —— 完整 `Insights` JSON + `_meta`（model / uiLanguage / generatedAt / rawMarkdown）。

**去重契约 `ensureInsightTask(videoSha, uiLanguage)`：**

镜像 `TranslateQueue.ensureTask`：

```
1. SELECT * FROM insight_tasks WHERE video_sha=? AND ui_language=?
2. 存在：
   - status IN ('queued','running','done') → 返回现有 task
   - status IN ('error','canceled')        → UPDATE status='queued', error_msg=NULL → 返回（resurrection）
3. 不存在：INSERT 新行 status='queued' → 返回
4. await llmQueue.tryStartNext()
```

---

## §5 — 错误处理与边界

**错误码（沿用现有 insight worker 词表）：**

| code | 触发场景 |
|---|---|
| `CANCELED` | 用户显式 cancel 或 boot 时被恢复成 canceled |
| `PARSE_FAILED` | 两次 retry 后 markdown parse 仍失败 |
| `VIDEO_TOO_LONG` | prompt > MAX_PROMPT_CHARS（沿用现有 80k 阈值） |
| `FATAL_UNKNOWN` | 兜底 |

错误码写入 `insight_tasks.error_msg`，前端通过 `/api/queue/list` 读出渲染。

**Worker 崩溃：**

- LLMQueue 的 worker promise `.catch()` 记 `llm_worker_crashed` 日志（含 `kind: 'translate'|'insight'`）
- DB 状态留在 `running`（zombie）→ 下次 boot 由 `02.recover-zombie-tasks.ts` 处理（已有逻辑）

**llama-server 进程死/重启：**

- worker 抛异常 → 标 `failed` / `error` → 用户面板看到错误 → 手动重试
- **不**自动重试

**饿死风险：**

- FIFO + 单 worker，理论上长 translate 阻塞所有 insight（反之亦然）
- 缓解：用户可手动 cancel 占 slot 的任务
- 不在本设计内引入抢占或 priority

**死锁风险：**

- 不存在 —— 单 worker、无跨队列锁

**结果文件丢失自愈（顺手修既有 bug）：**

`LLMQueue.attach(taskId)` 在两类 worker 都需统一这条规则：

- 如果 DB row 表明任务已完成（translate `'completed'` / insight `'done'`）但结果文件缺失（`{cache}/{hash}/{lang}.vtt` 或 `insights.json` 不存在）：
  1. 记日志 `result_file_missing_resurrect`（含 taskId / kind / 期望文件路径）
  2. UPDATE row 回 `'queued'`，清 `error_msg` / `progress_pct`
  3. emit `status: 'queued'` 帧
  4. `await this.tryStartNext()`
  5. 走正常的 live-tail 等 worker 重跑

- 触发场景：进程在 `cache delete` 中途崩溃（已删文件未删 row）、用户手动 `rm` 文件、磁盘损坏后部分恢复
- 这条规则同时修复了既有 `TranslateQueue.attach` 的同名 bug（status='completed' 但 vtt 缺失会走 dead branch 卡住）

---

## §6 — Recovery 与生命周期

**`02.recover-zombie-tasks.ts` 改动：**

```diff
- await translateQueue.tryStartNext();
+ await llmQueue.tryStartNext();
```

现有的 desktop / web 模式分支不动 —— 已经处理 `insight_tasks` 的 running → queued / error 转换。

**Electron `before-quit` 钩子（`server/api/desktop/shutdown.post.ts`）：**

- `transcribeQueue.cancelActive()` 不变
- `translateQueue.cancelActive()` → `llmQueue.cancelActive()`，内部 abort 当前 active（无论 kind 是 translate 还是 insight）
- `abortAllInsightTasks()` 整个删除 —— 因为 LLM 单 worker 模式下任意时刻最多 1 个 insight 在跑，已被 `llmQueue.cancelActive()` 覆盖
- 返回字段 `abortedInsights` 保留（值改为 boolean → number：active.kind === 'insight' ? 1 : 0），调用方 Electron main 不会读这字段，但保持 API shape 不破

**Boot 启动顺序（`server/plugins/00.queue.ts` + `02.recover-zombie-tasks.ts`）：**

- `00.queue.ts`：transcribe 立即起；`llmQueue.tryStartNext()`（替换 `translateQueue.tryStartNext()`）
- `02.recover-zombie-tasks.ts`：处理 zombie translate + insight 行后再 `llmQueue.tryStartNext()`
- 行为不变：02 在 00 之后跑，所以 02 的 nudge 是兜底

---

## §7 — 前端

**任务面板（`app/pages/index.vue`）：**

```vue
<!-- existing -->
<span v-if="item.kind === 'transcribe'">{{ item.doneChunks }}/{{ item.totalChunks }} chunks</span>
<span v-else-if="item.kind === 'translate'">{{ item.targetLang }} · {{ item.model }}</span>
<!-- new -->
<span v-else-if="item.kind === 'insight'">{{ uiLangLabel(item.uiLanguage) }} · {{ item.model }}</span>
```

进度条：insight 的 `progressPct` 始终是 0（无法粒度上报），running 时直接复用现有"未上报进度的 translate"的 0% 渲染，done 时按 status 切换为完成态，error 时按 status 切换为错误态。无需新组件 / 新样式。

**取消按钮：**

`onCancel(item)` 加分支：
```ts
if (item.kind === 'insight') await $fetch(`/api/queue/insight/${item.id}`, { method: 'DELETE' });
```

**Insight 详情面板（不在本次范围）：**

- 现有 `InsightsPanel.vue` 不动
- 现有 `/api/insights` SSE 协议向前兼容（新增 `status` 事件被忽略）
- 可选增强：识别 `status: 'queued'` 显示"排队中" —— 留作后续小特性

---

## §8 — 非目标 (YAGNI)

明确不在本次范围：

- 任务优先级 / 抢占 —— 全 FIFO
- 跨语言 / 跨模型的 insight 缓存共享 —— 维持 `(video_sha, ui_language)` 唯一
- 三队列合并 —— transcribe 独立
- 自动重试 LLM 失败 —— 用户手动重试
- "前面还有 N 个任务" 排队位置展示 —— 简化协议（前端可自行从 `/api/queue/list` 计算）
- 后端推送排队位置变化 —— polling 已够用
- result_json DB 列 —— 文件持久化已够用

---

## §9 — 验收清单

- [ ] `ensureInsightTask` 单元测试覆盖去重（queued / running / done / error / canceled 五种状态）
- [ ] `LLMQueue.tryStartNext` 集成测试：translate 和 insight 同时 enqueue，FIFO 顺序起
- [ ] `/api/queue/list` 返回包含 insight 形态
- [ ] `DELETE /api/queue/insight/[id]` 取消 active insight
- [ ] `DELETE /api/queue/insight/[id]` 取消 queued insight（不在 active）
- [ ] HTTP 客户端断开 → 任务继续跑 → 重连可恢复 token 流（mid-flight）
- [ ] HTTP 客户端断开 → 任务跑完 → 重连立即拿到 `done` 帧（read from `insights.json`）
- [ ] Boot 后 zombie running insight → queued → 自动启动 → 跑完
- [ ] 首页面板显示 insight 任务的 queued / running / done / error 四种状态
- [ ] Electron quit 时 active insight 干净落到 `error` 或 `canceled`，无 zombie
- [ ] 重新转写视频 (`/api/transcribe/retry`) 时，跑着的 insight 被取消
- [ ] 删除单个视频缓存 (`/api/cache/[hash]`) 时，跑着的 insight 被取消
- [ ] 缓存列表 (`/api/cache/list`) 正确反映 insight 任务在跑的状态
- [ ] `translateQueue` thin facade 调用站点（`server/api/translate.get.ts` 等）行为零回归
- [ ] 模拟 insight `done` row 但 `insights.json` 文件被删 → attach 触发 resurrect → 任务重跑 → 完成
- [ ] 模拟 translate `completed` row 但 `{lang}.vtt` 文件被删 → attach 触发 resurrect → 任务重跑 → 完成（修复既有 bug）

---

**下游：** 待用户 review 本 spec 后，调用 `writing-plans` skill 生成 slice-by-slice 实施计划。
