# Subcast — Player UX Enhancement Design Spec

> 在已发布的 V1.0 基础上增加两项纯前端可用的体验增强：**字幕导出** 和 **字幕搜索**。  
> 本文为 superpowers brainstorming 流程产出。下游：`writing-plans` 生成实施计划。

**版本**：v1.0
**创建日期**：2026-05-12
**关联**：`docs/superpowers/specs/2026-05-09-subcast-design.md`（V1.0 主设计；本文沿用其架构约定）

---

## 决策摘要

经一问一答 brainstorming 确认：

| 维度 | 选择 | 否决项 / 理由 |
|---|---|---|
| **Slice 切分** | 一个 spec 合并 A（导出）+ C（搜索） | 都是播放器内 UI 增强；AI 总结（E）单独立项，本文不涉及 |
| **导出格式** | VTT + SRT + TXT + 双语-VTT + 双语-SRT | 不做 ASS（用户用 ffmpeg 自处理）；不做"导出整库"批量 |
| **导出入口** | 播放器工具栏新增 `Export` 按钮 → Modal | 不在语言下拉里塞下载小图标；不进 Settings 页 |
| **多文件交付** | 服务端 `archiver` 流式 ZIP | 不逐个触发浏览器下载 |
| **导出生成位置** | 服务端 `/api/export` | 不在浏览器端 fetch + 转换；为将来"批量导出"复用同一路径 |
| **搜索范围** | 仅当前显示语言 | 不做跨语言；不做正则 |
| **搜索交互** | 高亮 + `↑↓` 在匹配间循环 | 不做"过滤模式"（破坏时间上下文） |
| **双语字幕排列** | 原文在上、译文在下 | 影视行业惯例 |

---

## §1 — 范围与文件清单

**新增**

| 路径 | 类型 | 职责 |
|---|---|---|
| `server/api/export.get.ts` | API | 单文件 / 双语合并 / ZIP 三合一端点 |
| `server/utils/subtitle-formats.ts` | Util | VTT↔SRT/TXT/双语 格式转换 |
| `app/components/player/ExportDialog.vue` | Component | 导出 Modal |
| `app/components/player/SearchBar.vue` | Component | 字幕搜索栏 |
| `server/utils/subtitle-formats.test.ts` | Test | 格式转换单测 |
| `server/api/export.test.ts` | Test | API 集成测试 |

**修改**

| 路径 | 改动 |
|---|---|
| `app/pages/player/[hash].vue` | 挂载两个新组件；工具栏放 Export 按钮；绑定 `/` 与 `Ctrl/Cmd+F` 快捷键；cue 列表渲染时叠加 `<mark>` 高亮 + match 行底色 |
| `package.json` | 新增 `archiver` 依赖（流式 ZIP） |
| `README.md` | API 端点表新增 `/api/export` 一行；功能亮点段提到"字幕导出 / 搜索" |
| `i18n/locales/en.json`、`i18n/locales/zh-CN.json` | 新增 `player.export.*` 与 `player.search.*` 命名空间字符串 |

---

## §2 — `/api/export` 端点契约

### 入参

```
GET /api/export
  ?hash=<sha256>
  &langs=<lang1[,lang2,...]>      # 逗号分隔，'original' 是合法值
  &format=<vtt|srt|txt|bilingual-vtt|bilingual-srt>
```

### 响应分支

| 入参组合 | 响应类型 | filename |
|---|---|---|
| 1 个 lang + 非 bilingual format | 直接 stream 该格式文件 | `{name}.{lang}.{ext}` |
| 2 个 langs + `bilingual-*` | 合并文件 | `{name}.{lang1}+{lang2}.{ext}` |
| ≥2 个 langs + 非 bilingual format | `archiver` 流式 ZIP | `{name}.subtitles.zip` |

- `{name}` = `videos.original_name` 去扩展名；为空则用 `subcast-{sha256.slice(0,8)}`
- 所有响应必带 `Content-Disposition: attachment; filename="..."`
- 单文件 MIME：`text/vtt` / `application/x-subrip` / `text/plain`；ZIP 用 `application/zip`

### 错误（沿用既有 `createError` 风格）

| 条件 | HTTP | code |
|---|---|---|
| `bilingual-*` 但 `langs` 数量 ≠ 2 | 400 | `INVALID_BILINGUAL_LANGS` |
| `langs` 中含未缓存的语言 | 400 | `LANG_NOT_CACHED`（data 含具体语言列表） |
| 双语合并但 cue 数 / 时间戳不一致 | 422 | `BILINGUAL_MISMATCH`（defense-in-depth；翻译管线保证不会触发） |
| `hash` 未知 | 404 | `VIDEO_NOT_FOUND` |
| `format` 非法 | 400 | `INVALID_FORMAT` |

---

## §3 — 字幕格式转换（`server/utils/subtitle-formats.ts`）

### 函数签名

```ts
export function vttToSrt(vtt: string): string;
export function vttToTxt(vtt: string): string;
export function mergeBilingualVtt(originalVtt: string, translatedVtt: string): string;
export function mergeBilingualSrt(originalVtt: string, translatedVtt: string): string;
```

### 转换规则

**VTT → SRT**：
- 去掉 `WEBVTT` header 与可选 metadata 行
- 时间戳 `HH:MM:SS.mmm` → `HH:MM:SS,mmm`
- 每个 cue 加 1-indexed 序号
- 保留 cue 内换行；不解析 voice tags `<v ...>`（当前 Subcast 不写这些）

**VTT → TXT**：
- 丢弃所有时间戳与序号
- 每个 cue 的文本作为一行输出
- cue 之间用单换行分隔（不留空行，紧凑形态便于丢 AI 总结）

**双语 VTT 合并**：
```
WEBVTT

00:00:01.234 --> 00:00:03.456
Hello world.
你好，世界。

00:00:04.000 --> 00:00:06.500
This is a test.
这是一个测试。
```
- 沿用原文的时间戳（与译文一致，已对齐保证）
- cue 文本块：第 1 行原文，第 2 行译文
- 校验：cue 数必须相等；任一时间戳不一致 → 抛错由 API 层转 `BILINGUAL_MISMATCH`

**双语 SRT 合并**：同上规则，时间戳用 SRT 格式 + 序号。

---

## §4 — UI 组件

### ExportDialog.vue

**Props**：
- `hash: string`
- `cachedLangs: string[]`（来自父组件 `Object.keys(cuesByLang).filter(l => langStatus[l] === 'done')`）
- `originalName: string`（用于显示"下载文件名预览"）

**布局**：
```
┌─────────────────────────────────────────┐
│  Export Subtitles                  ✕   │
├─────────────────────────────────────────┤
│ Languages                               │
│   ☑ Original                            │
│   ☑ 中文（简体）                          │
│   ☐ 日本語                               │
│                                         │
│ Format    [VTT ▾]                       │
│           VTT / SRT / TXT /             │
│           Bilingual VTT / Bilingual SRT │
│                                         │
│ ℹ Bilingual requires exactly 2 langs.   │
│                                         │
│              [Cancel]  [Download ⬇]    │
└─────────────────────────────────────────┘
```

**行为**：
- Languages 列表：从 `cachedLangs` 渲染
- Download 按钮启用条件：
  - 非 bilingual format：`selectedLangs.length >= 1`
  - bilingual format：`selectedLangs.length === 2`
- 不满足时按钮 disabled + 显示对应提示（`Select at least one language` / `Bilingual requires exactly 2 languages`）
- Download 按钮点击：拼 `/api/export?...` URL → `window.open(url, '_self')` → 浏览器原生处理下载
- 不做 XHR + Blob：避免 ZIP 包占用 JS 内存

### SearchBar.vue

**Props**：`cues: CueData[]`（当前显示语言的 cue 数组）

**Emits**：
- `update:query (string)`：用于父组件传给 cue 列表做行高亮 / 文本 `<mark>` 包裹
- `update:matchIdx (number | null)`：父组件用此值滚动 cue 列表到目标 cue

**内部状态**：
- `query`（string，受控）
- `matches`（computed：`cues.map((c, i) => match(c.text, query) ? i : -1).filter(i => i >= 0)`）
- `cursor`（number，0..matches.length-1，受 `↑↓` / Enter 控制）

**UI**：
- 默认折叠为一个 🔍 图标在右侧字幕面板顶部
- 展开：`[输入框] [12/47 计数] [↑] [↓] [✕]` 一行
- 输入 debounce 80ms 后重算 matches
- `Enter` → cursor++；`Shift+Enter` → cursor--；越界则 wrap
- `Esc` → 清空 query + 折叠
- 切换语言时：query 保留，matches 自动重算（cues 是响应式 prop）

**匹配规则**：
- `query.toLowerCase()` 与 `cue.text.toLowerCase()` 做 `includes` 子串匹配
- 字面匹配；不做正则；不做 fuzzy
- 空白 / 静音占位符 cue 不参与匹配（已经在父组件用 `ListItem.kind === 'silence'` 区分）

### 播放器集成 (`app/pages/player/[hash].vue`)

- 工具栏添加 `Export` 按钮（位置：语言下拉旁）→ `showExport.value = true`
- ExportDialog mount 在页面级，按 `showExport` 控制显隐
- SearchBar mount 在字幕列表面板顶部
- 全局 keydown 处理新增两个分支：
  - `/`（无 modifier、当前 focus 不在输入框时）→ 打开 SearchBar
  - `Ctrl/Cmd+F` → preventDefault + 打开 SearchBar
- cue 列表 `<li>` 渲染：
  - 若 `idx ∈ searchMatches` → 加 `bg-yellow-200/30` 行底色
  - 若 `idx === currentMatchIdx` → 额外 ring 高亮 + `scrollIntoView({ block: 'center' })`
  - cue text 渲染走 `highlightSubstring(text, query)`，把匹配子串包 `<mark class="bg-yellow-300/60 text-inherit">`

---

## §5 — 错误处理总览

| 场景 | 行为 |
|---|---|
| `/api/export` 返回 400/404/422 | 浏览器直接显示 JSON（导出不是高频路径，不做客户端 toast 二次包装） |
| ZIP 流中途网络中断 | 部分 ZIP 已落盘；浏览器报文件损坏。设计上接受 |
| 搜索查询无匹配 | 计数器显示 `0/0`；`↑↓` 按钮 disabled；不弹任何提示 |
| 输入超长 / 特殊字符 | 全部作字面子串处理；不解析正则；Vue 默认 XSS 转义保证安全 |
| 切换语言后旧 matches 失效 | computed 自动重算；cursor 若超界则重置为 0 |

---

## §6 — 测试

### 必写（vitest 单测）

**`server/utils/subtitle-formats.test.ts`**
- VTT → SRT：时间戳 `.` → `,`、序号 1-indexed、cue 间空行
- VTT → TXT：去掉时间戳 / 序号、每 cue 一行、无空行
- 双语合并 VTT：正常 case
- 双语合并 VTT：cue 数不一致 → 抛错
- 双语合并 SRT：同上两条

**`server/api/export.test.ts`**
- 单语 VTT：响应 header 含 `Content-Disposition` + `text/vtt`
- 单语 SRT：body 是合法 SRT
- 单语 TXT：body 是纯文本
- 双语合并：body 含两种语言行
- 多语 ZIP：解压后包含正确文件名 + 内容
- bilingual 但 lang 数 ≠ 2 → 400 + `INVALID_BILINGUAL_LANGS`
- 未缓存语言 → 400 + `LANG_NOT_CACHED`
- 未知 hash → 404

### 必跑（手动 QA，纳入 PR checklist）

- macOS Safari / Chrome 与 Windows Chrome / Edge：下载文件名扩展名正确
- 9 种 supported langs 全部缓存的视频 ZIP 流式下载
- 搜索：长视频（千行+ cue）输入响应是否流畅；快捷键在输入框 focus 时不误触发

### 不写

- ExportDialog / SearchBar 的组件层 vue-test-utils 用例：UX 正确性靠手测 + 后续 e2e 覆盖
- E2E（仓库目前无 e2e 框架；引入超出本 slice 范围）

---

## §7 — YAGNI（明确不做，留待后续 slice）

- ❌ ASS / SSA 格式导出
- ❌ "导出整个媒体库"跨视频批量
- ❌ 跨语言搜索 / 正则搜索 / fuzzy 搜索
- ❌ 导出格式默认值持久化到 settings
- ❌ ExportDialog 内的字幕预览 / diff
- ❌ 搜索匹配数 > 100 时的虚拟滚动（YAGNI；目前 cue 列表本身就没有虚拟化）

---

## §8 — 风险登记

1. **`window.open` 的 GET URL 长度**：理论上若有 30+ 语言一次性勾选 ZIP，URL 可能超 2 KB。当前 Subcast `SUPPORTED_LANGS` 只 9 项，远不到上限。**不处理**。
2. **`archiver` 包体积**：约 200 KB。备用方案 `jszip` 更小但需 buffer 整个 ZIP，否决。
3. **浏览器原生 `Ctrl/Cmd+F` 拦截**：preventDefault 后用户失去浏览器内查找。在播放器页这是预期（字幕搜索覆盖之），在其他页面不绑定该快捷键即可。
4. **`<mark>` 高亮对长文本性能**：单 cue 平均 < 100 字符，最坏 cue 数 ~ 1000+；computed 重算可接受（< 5 ms）。debounce 80 ms 进一步避免输入卡顿。

---

## §9 — 验收标准

V1.0 可上线判定：

1. 把已缓存了 2+ 语言的视频打开 → 工具栏 Export 按钮可见
2. Modal 中勾选 `Original + zh-CN`、format `Bilingual VTT` → 下载得到正确的双语 VTT 文件，VLC / IINA 中能正常加载
3. Modal 中勾选 3 个语言、format `SRT` → 下载得到 ZIP，解压后 3 个 SRT 各自有效
4. 按 `/` 或 `Ctrl/Cmd+F` → 字幕面板顶部 SearchBar 展开并 focus
5. 输入关键词 → 匹配 cue 行底色变化、cue 内子串包 `<mark>`、列表自动滚到第一个匹配
6. `Enter` / `Shift+Enter` 在匹配间循环；`Esc` 关闭
7. 切换语言后搜索 query 保留、matches 自动重算
8. 所有新增单测通过；`pnpm typecheck` 干净
