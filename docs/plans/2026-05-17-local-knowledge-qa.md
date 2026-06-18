# Subcast 本地知识库 + 跨文件 AI 问答需求文档

> 状态：需求草案 v0.1  
> 创建：2026-05-17  
> 目标版本：v0.4.0  
> 关联能力：Library、Search、AI Insights、Diarization、Batch Processing、Local LLM

## 1. 背景

Subcast 当前已经具备本地转录、翻译、AI 总结、章节、说话人识别、批处理和媒体库能力。用户把音视频导入后，可以在单个文件内观看、搜索、导出和生成 insights。

下一步最有产品竞争力的演进，是把这些离散文件变成可查询、可组织、可追问的本地知识库。用户不只是得到一份字幕，而是可以围绕一组视频或音频问问题、找证据、总结观点、追踪行动项，并且全程保持离线和隐私。

这项能力的核心差异化不是“也能聊天”，而是：

- 数据不上传云端。
- 支持跨多个本地音视频文件检索和回答。
- 回答必须带来源文件、时间戳、原文片段，可一键跳回播放器。
- 利用已有说话人识别、章节、摘要和批处理能力，形成长期可积累的个人/团队媒体知识库。

## 2. 产品目标

### 2.1 主要目标

1. 让用户能在整个 Subcast 媒体库中查找信息，而不是逐个打开文件。
2. 让用户能对一个文件集合提问，并得到带引用来源的本地 LLM 回答。
3. 把转录结果沉淀成可复用的知识资产：项目、标签、人物、主题、章节、行动项。
4. 坚持 Subcast 的隐私定位：默认离线、无遥测、无云 API 依赖。

### 2.2 已确认决策

| # | 决策 | 说明 |
|---|---|---|
| D1 | 独立 `/knowledge` 页面 | Header 与 Home / Library 并列新增"知识库"入口 |
| D2 | MVP 范围不做完整标签系统 | 先支持全部文件、当前搜索结果、手动选择文件；UI 预留标签扩展位 |
| D3 | 问答历史默认本地保存 | 用户可删除；diagnostics 默认不包含 |
| D4 | v0.4.0 不做 embedding | 先做关键词检索；语义检索进入后续版本 |
| D5 | MVP 纳入中文 n-gram 索引 | 不只依赖 SQLite FTS5 默认中文行为 |
| D6 | 问答接入现有 `llmQueue` | 与翻译、AI insights 共用本地 LLM 调度 |

### 2.3 成功指标

MVP 完成后，应满足：

- 用户可以从 Header 进入独立 Knowledge 页面。
- 用户可以选择全部文件、当前搜索结果、手动选择文件作为问答范围。
- 对 50 个已转录文件的媒体库，普通关键词搜索在 300 ms 内返回首屏结果。
- 对 10 个文件范围内的问题，本地回答能在 15 秒内开始流式输出。
- 每个回答至少包含 1 个可点击来源；无来源时必须明确说“不确定”，不能编造。
- 关闭网络后，已安装模型和已索引文件仍可完整使用搜索与问答。

## 3. 目标用户与场景

### 3.1 内容创作者

用户会导入访谈、播客、课程、直播回放、长视频素材。常见问题：

- “这个嘉宾在哪几处提到定价？”
- “帮我找出所有适合剪成短视频的观点。”
- “总结这三期播客里关于 AI 工具的共同观点。”
- “生成一份带时间戳的剪辑提纲。”

### 3.2 学习与研究用户

用户会导入课程、讲座、会议录像、公开访谈。常见问题：

- “这一批课里讲 transformer 的地方有哪些？”
- “把这些视频里关于评估指标的内容整理成笔记。”
- “谁反对这个观点？引用原文。”

### 3.3 会议与访谈整理用户

用户会导入会议录制、用户访谈、销售录音。常见问题：

- “列出所有行动项和负责人。”
- “客户提到最多的痛点是什么？”
- “Alice 对发布时间有什么承诺？”

## 4. MVP 范围

### 4.1 知识库首页

新增独立 `/knowledge` 页面，Header 里和 Home / Library 并列新增"知识库"入口。页面提供：

- 全库搜索框。
- 最近索引状态。
- 文件范围选择：全部文件、当前搜索结果、手动选择文件。
- 问答输入区。
- 回答历史列表。

MVP 不做复杂 dashboard，不做营销式首页。页面应更像工作台：搜索、范围、回答、来源。

### 4.2 本地索引

MVP 索引对象：

- 原文转录 cues。
- 文件标题 / display name / original name。
- AI insights summary、bullets、chapters。
- 说话人标签和用户重命名后的 speaker display name。

MVP 使用 SQLite FTS5 做全文索引，并在索引阶段生成中文 2-gram / 3-gram 搜索文本来改善中文召回。语义向量检索作为 Phase 3，不进入 v0.4.0。

索引触发：

- 转录完成后自动入索引。
- insights 生成或刷新后更新索引。
- speaker 重命名后更新相关 speaker 字段。
- 文件删除、清缓存、重转录后同步清理或重建索引。

### 4.3 跨文件搜索

搜索结果应包含：

- 文件名。
- 命中片段。
- 时间戳。
- 语言 / speaker（如果有）。
- 点击后跳转到 `/player/<hash>?t=<ms>`。

MVP 支持：

- 关键词搜索。
- 文件名过滤。
- 当前搜索结果作为问答范围。
- 手动选择文件作为问答范围。
- 只搜当前选择范围。

MVP 暂不要求高级搜索语法，但内部应保留扩展空间，例如 `speaker:Alice`、`lang:zh-CN`、`before:2026-05-01`。

### 4.4 跨文件 AI 问答

用户输入问题后，系统流程：

1. 根据当前范围做本地检索。
2. 取 Top N 片段组成上下文。
3. 通过现有 `llmQueue` 排队调用本地 LLM 流式生成回答。
4. 回答中展示引用来源列表。
5. 每个来源可跳转到播放器对应时间点。

回答要求：

- 必须基于检索片段。
- 必须引用来源，来源包括文件名和时间戳。
- 证据不足时明确说明无法确定，并给出已找到的相关片段。
- 不把完整转录文本塞进 prompt；只传检索后的片段。

MVP 回答结构：

```md
回答正文

来源
- 文件 A · 12:34 · speaker_A
- 文件 B · 03:21
```

UI 中不要求 Markdown 源码展示，但复制时保留 Markdown 格式。

### 4.5 问答历史

MVP 保存本地问答历史：

- question
- answer
- selected scope
- cited sources
- model
- created_at

用户可以删除单条历史。MVP 不做云同步、不做多设备。

### 4.6 文件组织

MVP 支持轻量范围组织方式：

- 全部文件。
- 当前搜索结果。
- 手动多选文件集合，但不持久化。

完整标签系统有长期价值，但不进入 v0.4.0。UI 的范围选择控件需要预留未来加入"标签"的扩展位置。

## 5. 非目标

MVP 不做：

- 云端问答、云端 embedding、团队协作。
- 自动同步 Notion、Obsidian、飞书、Slack。
- 复杂知识图谱可视化。
- 自动识别跨文件同一说话人的声纹身份。
- 对未转录文件实时问答。
- 直接回答超出素材库之外的通用知识问题。
- Web 搜索增强。
- 多轮 agent 自动执行剪辑或导出。

## 6. 功能需求

### 6.1 索引状态

- 系统必须能判断某个视频是否已索引。
- 系统必须能重建单个文件索引。
- 系统必须能重建全库索引。
- 索引失败不能影响原有播放、转录、翻译、导出能力。

### 6.2 搜索

- 搜索输入为空时显示最近打开或最近完成转录的文件。
- 输入关键词后，结果按相关性和最近打开时间排序。
- 命中片段最多展示 2 行，避免泄露过长 transcript 到日志或错误信息。
- 搜索结果点击后打开播放器并 seek 到命中 cue 起点。

### 6.3 问答范围

用户必须能清楚看到当前问题的范围：

- 全部文件。
- 当前文件。
- 已选择 N 个文件。
- 当前搜索结果。

范围为空时，问答按钮禁用并提示原因。

### 6.4 检索上下文

- 默认取 8-16 个片段进入 LLM 上下文。
- 单个片段应包含：文件名、时间戳、speaker、cue text、相邻上下文。
- 相邻上下文最多取前后各 1 个 cue，避免上下文过大。
- 如果检索结果太少，回答应转为“找到的相关内容很少”模式。

### 6.5 回答生成

- 使用现有本地 LLM 后端和 LLM 队列，避免新增独立执行器。
- 知识库问答必须接入现有 `llmQueue`，与翻译和 insights 共用本地模型调度。
- 支持 SSE 流式输出。
- 生成中可以取消。
- 同一时间避免多个重型问答任务挤占翻译和 insights；MVP 可共用 `llmQueue`。
- 回答完成后写入本地历史。

### 6.6 引用来源

每条引用至少包含：

- video_sha
- display title
- startMs
- endMs
- snippet
- speakerId / displayName（可选）

来源列表在 UI 中必须可点击。

回答正文如果包含引用标记，推荐格式为 `[1]`、`[2]`。MVP 可以先在回答下方统一列出来源，不要求模型在每句话后精确插入引用。

### 6.7 隐私与日志

- 不记录完整问题、回答、转录片段到普通日志。
- debug 模式之外，日志只记录长度、hash、数量、耗时、错误码。
- diagnostics 导出默认不包含问答历史和 transcript 片段。
- 如果未来支持导出问答历史，必须由用户显式触发。

## 7. 数据模型建议

具体实现可调整，但需求层面需要这些概念。

### 7.1 `knowledge_chunks`

每条可检索片段一行：

```sql
CREATE TABLE knowledge_chunks (
  id              TEXT PRIMARY KEY,
  video_sha       TEXT NOT NULL REFERENCES videos(sha256),
  source_kind     TEXT NOT NULL, -- cue | insight_summary | insight_chapter
  lang            TEXT,
  speaker_id      TEXT,
  start_ms        INTEGER,
  end_ms          INTEGER,
  text            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

### 7.2 FTS 表

```sql
CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
  text,
  title,
  speaker,
  content='knowledge_chunks',
  content_rowid='rowid'
);
```

实际实现时需要注意 `better-sqlite3` rowid 映射和迁移兼容性。

### 7.3 `qa_sessions` / `qa_messages`

MVP 可以简化为单表：

```sql
CREATE TABLE qa_history (
  id              TEXT PRIMARY KEY,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  scope_json      TEXT NOT NULL,
  sources_json    TEXT NOT NULL,
  model           TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
```

问题和回答属于用户内容，不能进入普通 diagnostics。

### 7.4 `tags` / `video_tags`

```sql
CREATE TABLE tags (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE video_tags (
  video_sha   TEXT NOT NULL REFERENCES videos(sha256),
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_sha, tag_id)
);
```

标签可作为范围选择和 Library 组织能力共用。

## 8. 用户体验要求

### 8.1 Knowledge 页面布局

推荐结构：

- 顶部：搜索框 + 范围选择。
- 左侧：结果/历史列表。
- 右侧：问答面板。
- 底部或回答内：来源列表。

移动端或窄窗口下可上下堆叠，但桌面主体验应优先支持横向扫描。

### 8.2 空状态

没有任何已转录文件时：

- 显示“导入并转录文件后即可建立本地知识库”。
- 提供回到首页上传的按钮。

有文件但未索引时：

- 显示索引进度或“重建索引”按钮。

### 8.3 生成中状态

- 流式显示回答。
- 显示当前使用的范围和模型。
- 显示“正在查找来源 / 正在组织回答”等短状态。
- 提供取消按钮。

### 8.4 错误状态

常见错误：

- `NO_INDEXED_CONTENT`：没有可检索内容。
- `LLM_NOT_READY`：本地 LLM 未安装或未运行。
- `CONTEXT_TOO_LARGE`：范围太大，已自动截断或要求缩小范围。
- `ANSWER_CANCELED`：用户取消。
- `SEARCH_FAILED`：FTS 查询失败或索引损坏。

错误文案应给出下一步操作，而不是只显示堆栈。

## 9. API 需求

建议新增端点：

```txt
GET    /api/knowledge/search?q=&scope=
POST   /api/knowledge/ask
DELETE /api/knowledge/ask/:id
GET    /api/knowledge/history
DELETE /api/knowledge/history/:id
POST   /api/knowledge/reindex
POST   /api/knowledge/reindex/:hash
GET    /api/tags
POST   /api/tags
PATCH  /api/tags/:id
DELETE /api/tags/:id
POST   /api/cache/:hash/tags
DELETE /api/cache/:hash/tags/:id
```

`POST /api/knowledge/ask` 使用 SSE 或返回 task id 后由 SSE attach。为了贴合现有 insights 和 translate 体验，推荐直接 SSE：

```json
{
  "question": "这些访谈里用户最常抱怨什么？",
  "scope": {
    "kind": "tags",
    "tagIds": ["tag-user-interview"]
  }
}
```

SSE events：

| event | data | 含义 |
|---|---|---|
| `retrieval` | `{ sources }` | 检索完成，先展示来源候选 |
| `start` | `{ taskId, model }` | LLM 开始 |
| `token` | `{ text }` | 回答 token |
| `done` | `{ answer, sources, historyId }` | 完成并保存 |
| `error` | `{ code, message }` | 失败 |

## 10. 性能要求

### 10.1 搜索

- 1,000 个文件、100 万 cue 以内，关键词搜索首屏目标 < 800 ms。
- 50 个文件以内，关键词搜索首屏目标 < 300 ms。
- 搜索不应阻塞转录队列。

### 10.2 索引

- 单个 1 小时视频索引目标 < 3 秒，不含转录时间。
- 全库重建可后台运行，并展示进度。
- 索引任务可被取消，但取消不应破坏已有旧索引。

### 10.3 问答

- 检索阶段目标 < 1 秒。
- 回答开始流式输出目标 < 15 秒。
- 默认上下文片段数需受模型上下文限制保护。

## 11. 分阶段路线

### Phase 1：全文知识库 MVP

交付：

- SQLite FTS5 + 中文 n-gram 索引。
- 独立 Knowledge 页面。
- 全库 / 当前搜索结果 / 手动选择文件范围。
- 跨文件搜索。
- 本地问答 + 来源列表。
- 问答历史。
- 重建索引。

不交付：

- embedding 语义搜索。
- 标签系统。
- 自动标签。
- 知识图谱。
- 外部同步。

### Phase 2：标签、集合与更好的引用

交付：

- 标签系统。
- 保存的文件集合。
- speaker 和章节作为过滤条件。
- 回答正文 `[1]` 引用标记。
- 复制为 Markdown / 导出问答结果。

### Phase 3：本地语义检索

交付：

- 本地 embedding 模型选型和安装。
- 向量索引或 SQLite 向量扩展可行性验证。
- 混合检索：FTS + embedding。
- 中文、英文、双语转录的召回优化。

### Phase 4：工作流化

交付：

- “从这批文件生成研究笔记”。
- “从这批访谈生成用户痛点表”。
- “从这些视频生成剪辑候选片段”。
- Watch Folder 完成后自动入库、索引、生成摘要。

## 12. 验收标准

### 12.1 功能验收

- 导入并转录 3 个测试文件后，Knowledge 搜索能命中跨文件片段。
- 对“总结这几个文件共同讨论的主题”提问，回答带至少 2 个来源。
- 点击来源能打开正确播放器并 seek 到正确时间。
- 删除一个文件后，该文件不再出现在搜索和问答来源中。
- 重转录一个文件后，旧索引被替换。
- 无网络环境下，搜索和问答仍可使用。

### 12.2 隐私验收

- 普通日志中不出现原始问题、回答、转录片段、文件名。
- diagnostics 默认不包含 `qa_history` 和 `knowledge_chunks.text`。
- debug 模式下如需导出，也必须经过已有 sanitizer 或显式用户动作。

### 12.3 回归验收

- 现有上传、转录、翻译、insights、diarization、export 流程不退化。
- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- `pnpm lint` 通过。

## 13. 风险与开放问题

### 13.1 FTS 对中文分词的效果

SQLite FTS5 默认 tokenizer 对中文召回有限。v0.4.0 已确认纳入中文 n-gram 索引：索引阶段除原始文本外，生成适合 FTS 的 2-gram / 3-gram 搜索文本。仍需用真实中文样本验证召回质量。

### 13.2 本地 LLM 幻觉

问答必须以检索片段为边界。Prompt 应明确要求“只依据 SOURCES 回答”。UI 也要把来源候选先展示出来，降低用户误信无来源回答的风险。

### 13.3 上下文窗口

长问题或大范围检索容易超过本地模型上下文。MVP 应控制片段数，并在回答中说明“已基于最相关片段回答”。不要静默塞入过多 transcript。

### 13.4 索引一致性

转录、重转录、删除、批处理、导入字幕都会影响索引。实现时需要把索引更新放在媒体图谱删除和任务完成路径里统一处理，避免陈旧来源。

### 13.5 UI 复杂度

Knowledge 页面容易膨胀成复杂工作台。MVP 应克制：搜索、范围、问答、来源四件事先打磨顺。

## 14. 推荐优先级

最高优先级：

1. FTS 索引与重建。
2. 跨文件搜索。
3. 带来源的本地问答。
4. 来源跳转播放器。
5. 隐私日志保护。

可以延后：

1. 标签系统。
2. 保存集合。
3. embedding 语义检索。
4. 问答导出。
5. 自动化工作流模板。

## 15. MVP Definition of Done

- 用户能在 Knowledge 页面搜索全库 transcript。
- 用户能选定范围并向本地 LLM 提问。
- 回答流式输出，并带可点击来源。
- 所有数据保存在本地 SQLite / cache，不依赖网络。
- 删除或重转录文件后索引一致。
- 隐私和 diagnostics 规则通过测试。
- 有针对搜索、索引、问答 API 的单元测试或集成测试。
