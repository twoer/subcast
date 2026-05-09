# Subcast 需求清单

> Sub + Cast — 本地化运行的多语言字幕播放器

## 一、项目定位

完全本地运行的视频字幕工具：上传音视频 → 本地 AI 转写 → 浏览器播放 + 多语言字幕实时切换。**无需联网、无需付费 API、隐私 100% 不出本机**。

**明确不做（V1）**：
- ❌ 不接受任何 URL 输入（YouTube/B站/Vimeo 等在线视频）
- ❌ 不调用任何云端 API（转写/翻译均本地）
- ❌ 不收集任何遥测或匿名统计

### 核心卖点

- 🔒 **隐私优先**：所有数据和模型推理都在本机完成
- 💸 **零费用**：不调用任何付费云 API
- 🌍 **多语言**：原文 + 任意目标语言字幕，自由切换
- ⚡ **流式体验**：边转写边播放，不傻等

---

## Clarifications

### Session 2026-05-09

- Q: 长视频转写中途中断（关闭浏览器/重启 Node/断电）后如何恢复？ → A: 自动断点续传（chunk 级持久化），从最后完成的 30s chunk 继续
- Q: 用户连续上传多个视频时如何调度？ → A: 单活跃任务 + FIFO 队列（同时只跑 1 个转写，其余排队，UI 显示队列状态）
- Q: 首次启动时本机缺少 Ollama 或 Whisper 模型如何引导？ → A: 检测 + 引导 + 一键脚本（启动检测缺失项，UI 给出可复制的平台对应安装命令；模型由 nodejs-whisper 自动下载并展示进度）
- Q: 字幕编辑功能是否纳入 V1？ → A: 不纳入；V1 字幕只读（编辑功能及其级联策略推迟到 V2.0+ 再决策）
- Q: 用户上传的视频文件如何存储？ → A: 复制到缓存目录（`~/.subcast/videos/`），与字幕一起统一管理，不依赖原文件路径
- Q: Nuxt 服务监听哪个地址？是否需要认证？ → A: 默认绑定 `0.0.0.0`，局域网完全开放无认证（信任本地可信网络场景）
- Q: 不同硬件下 Whisper / 翻译模型档位策略？ → A: 启动检测硬件（内存/CPU/GPU）+ 推荐档位 + 用户可改（Whisper 与 Qwen 翻译模型同策略）
- Q: Whisper 转写出现幻觉/时间戳错乱时如何处理？ → A: 检测异常（重复 3+ 次、时间戳逆序、密度异常）后自动用不同参数（temperature 抖动 / 关闭 condition_on_previous_text）重试当前 chunk，最多 2 次
- Q: 本地工具的可观测性最低标准是什么？ → A: 结构化日志（JSONL）+ UI 错误详情抽屉 + 一键导出脱敏诊断包（不含遥测上报）
- Q: UI 界面语言策略？ → A: 中英双语 + 自动检测（`@nuxtjs/i18n`，按 `navigator.language` 决定默认，顶部可手动切换）
- Q: 用户已有字幕文件（SRT/VTT）如何处理？ → A: 上传时检测同名/伴生字幕文件，弹窗让用户选择「使用并跳到翻译」或「忽略并重新转写」
- Q: 是否支持视频 URL（YouTube/B站等在线视频）作为输入？ → A: V1 仅支持本地文件，守住「完全本地 + 隐私优先」定位；用户需自行下载后拖入
- Q: 多语言翻译并发调度策略？ → A: 翻译串行（同时只翻 1 种语言）+ 用户当前选中的语言可插队（跳到队首）
- Q: 视频播放器学习场景能力范围？ → A: 学习者必备子集 — 倍速（0.5x-2x 七档）+ 点字幕条目跳转 + 快捷键（V1 范围；AB 循环/画中画/查词留 V1.1+）
- Q: Whisper 输出的非语音段（[音乐]/[掌声]/长静音）如何处理？ → A: 保留有效标签（`[Music]`/`[Applause]` 等参与翻译），真静音段（默认 ≥ 10s）在字幕列表显示「── 无语音 ──」分隔符

---

## 二、用户角色

| 角色 | 典型场景 |
|---|---|
| 学习者 | 看英文教程/演讲，需要中文字幕辅助 |
| 内容创作者 | 给自己拍摄的视频快速生成多语字幕 |
| 隐私敏感用户 | 内部会议录像、不愿上传云端的素材 |

---

## 三、功能需求

### MVP（V1.0）— 必做

#### F1. 视频导入
- [x] 支持本地文件上传（拖拽 + 点击选择）
- [x] 支持格式：mp4 / mkv / mov / webm / mp3 / wav / m4a
- [x] 单文件 ≤ 2GB，时长 ≤ 2 小时
- [x] 上传后立即在播放器加载，可先播放再等转写
- [x] **任务队列**：同时只跑 1 个转写任务，其余进入 FIFO 队列；UI 顶部展示队列长度与每个任务状态（等待中 / 转写中 N% / 完成 / 失败）；用户可取消队列中任务
- [x] **伴生字幕检测与导入**：
  - 拖入视频时同时拖入 `.srt` / `.vtt` / `.ass` 文件 → 自动配对
  - 拖入视频文件检测到选区中存在「同基础名」字幕文件（`movie.mp4` 配 `movie.srt`）→ 自动配对
  - 配对成功 → 弹出 Dialog 让用户选择：
    - 「使用现有字幕」→ 跳过 Whisper 转写，字幕直接落入缓存作为 `original.vtt`，可立即触发翻译
    - 「忽略并重新转写」→ 走标准转写流程
  - 仅 SRT/ASS 自动转 VTT 入库（统一存储格式）
  - 用户已有的字幕语言通过 BCP-47 标签或文件名后缀（如 `movie.zh.srt`）识别；识别不到时默认按当前 Whisper 检测语言标记

#### F2. 语音转写（本地 Whisper）
- [x] 调用本地 whisper.cpp 转写为 VTT 格式
- [x] **流式输出**：每完成一个 chunk（约 30s）立即推送到前端
- [x] 显示进度：`已转写 mm:ss / 总时长`
- [x] 自动检测原始语言（也允许用户手动指定）
- [x] 词级时间戳（用于卡拉 OK 高亮，可选）
- [x] **断点续传**：每个 chunk 完成后立即落盘（视频 SHA256 + chunk 索引为键），中断后下次打开自动从最后完成的 chunk 继续，无需用户干预
- [x] **幻觉检测与自动重试**：每个 chunk 完成后跑一遍质量校验：
  - 检测规则：① 同一句字幕连续重复 ≥ 3 次；② 相邻 cue 时间戳逆序；③ 单 chunk cue 数 > 期望值的 2 倍（按语速估算）
  - 命中任一规则 → 用调整后的参数（`temperature: 0.4 / 0.6 / 0.8` 递增 + `condition_on_previous_text: false`）重跑该 chunk，最多 2 次
  - 重试仍失败 → 保留首次结果，在 SQLite 标记 `quality: 'suspect'`，UI 该段字幕加灰色边框 + tooltip 提示「转写质量可能异常」
- [x] **非语音段处理**：
  - **有效标签保留**：Whisper 原生输出的 `[Music]` / `[Applause]` / `[Laughter]` 等带方括号的非语音标签作为正常 cue 入库，参与后续翻译（中文场景翻为「[音乐]」「[掌声]」等）
  - **真静音段标注**：相邻 cue 间隔 ≥ 10 秒（用户可在设置调整阈值）→ 在字幕列表插入特殊条目「── 无语音 ──」（不进入 VTT 文件，仅 UI 展示），让用户明确感知系统未卡死
  - 视频播放过程中字幕区域在静音段保持空白，不显示任何 cue

#### F3. 字幕播放
- [x] HTML5 `<video>` + WebVTT `<track>` 原生方案
- [x] 字幕底部叠加显示
- [x] 字幕样式可调：字号、颜色、背景透明度
- [x] 点击字幕条目跳转到对应时间点
- [x] **倍速播放**：0.5x / 0.75x / 1x / 1.25x / 1.5x / 1.75x / 2x 七档可切换
- [x] **字幕列表面板**：右侧/底部展示完整字幕列表（按时间戳排序），当前播放条目高亮 + 自动滚动；点击任一条目跳转到对应时间点
- [x] **键盘快捷键**：
  - `Space` 播放 / 暂停
  - `← / →` 后退 / 前进 5 秒
  - `↑ / ↓` 音量 +/- 10%
  - `J / L` 后退 / 前进 10 秒（YouTube 风格）
  - `K` 播放 / 暂停（YouTube 风格）
  - `< / >` 倍速 -/+ 一档
  - `M` 静音切换
  - `F` 全屏切换
  - `C` 字幕开关
  - `1-9` 跳转到 10% / 20% ... / 90% 进度
  - 帮助页面/键盘图标可查看完整快捷键列表

#### F4. 多语言翻译（本地 LLM）
- [x] 调用本地 Ollama (qwen2.5:7b) 批量翻译
- [x] 支持目标语言：中文、英文、日文、韩文、法文、德文、西班牙文（可扩展）
- [x] 滑动窗口翻译，保持上下文连贯
- [x] 翻译进度可见
- [x] 翻译完成后字幕菜单自动出现该语言选项
- [x] **翻译队列调度**：与转写队列独立，自身规则：
  - 同时只跑 1 个翻译任务（避免 Ollama 并发拖慢）
  - 默认按用户配置的语言偏好顺序翻（设置里可拖动排序）
  - **用户可插队**：用户在播放器主动切到某未翻译语言 → 该语言任务立即提升到队列首位，正在翻译的当前任务不中断但下一个就轮到它
  - UI 在字幕语言菜单旁标注每种语言的状态：`✓ 就绪` / `⏳ 队列第 N 位` / `🔄 翻译中 N%`
- [x] **翻译失败重试**：单批次（30-50 条）翻译输出与输入条数不一致 → 自动用更小批次（15 条）重跑该批，最多 2 次；仍失败则回退到逐条翻译

#### F5. 字幕语言切换
- [x] 顶部下拉菜单：原文 / 已翻译语言列表
- [x] 切换零延迟（已翻译过的语言走缓存）
- [x] 未翻译的语言点击后触发翻译，进入「翻译中」状态

#### F6. 本地缓存
- [x] 同一视频（按文件 SHA256 哈希）转写结果永久缓存
- [x] 已翻译的语言永久缓存
- [x] **视频文件本身**：上传时拷贝到 `~/.subcast/videos/{sha256}.{ext}`，与字幕一起由应用统一管理（不依赖原文件路径，原文件可随意删除/移动）
- [x] **字幕缓存**：`~/.subcast/cache/{sha256}/{lang}.vtt`，加 `meta.json` 记录原始文件名、时长、转写时间等元数据
- [x] **历史记录**：基于 SHA256 索引展示「最近处理过的视频」列表
- [x] 提供「清除缓存」入口（可单条删除 / 全量清空 / 按时间清理）
- [x] **磁盘占用警示**：缓存目录超过用户设置阈值（默认 10GB）时 UI 提示

#### F7. 环境检测与引导
- [x] **启动自检**：Node 启动时检测 Ollama 是否运行（`http://localhost:11434/api/tags`）、目标模型（如 `qwen2.5:7b`）是否已拉取、whisper.cpp 二进制与模型文件是否就绪
- [x] **UI 健康面板**：未就绪的依赖在首页顶部黄色横幅展示，每项给出当前用户操作系统（macOS / Windows / Linux）对应的可复制安装命令
  - macOS：`brew install ollama && ollama pull qwen2.5:7b`
  - Linux：`curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:7b`
  - Windows：链接到 https://ollama.com/download
- [x] **Whisper 模型自动下载**：由 `nodejs-whisper` 触发，带进度条显示，无需用户手动操作
- [x] **依赖就绪后自动隐藏横幅**，无需重启服务

#### F8. 硬件自适应模型档位
- [x] **启动硬件探测**：检测系统总内存、CPU 核心数、GPU 类型（Apple Silicon / NVIDIA CUDA / 无）
- [x] **推荐档位规则**（首次启动写入用户配置）：

  | 硬件等级 | 内存 | GPU | Whisper | Ollama 翻译 |
  |---|---|---|---|---|
  | 入门 | < 8GB | 无 | `tiny` 或 `base` | `qwen2.5:1.5b` |
  | 标准 | 8-16GB | 无 / 集成 | `small` | `qwen2.5:7b` |
  | 推荐 | 16GB+ | M 系列 / 4060+ | `medium` 或 `large-v3` | `qwen2.5:7b` |
  | 高配 | 32GB+ | 4080+ / M2 Pro+ | `large-v3` | `qwen2.5:14b` |

- [x] **设置页可手动切换**：用户随时在「设置 → 模型」里改档位，切换后下次任务生效
- [x] **档位标识**：UI 任务卡片显示当前任务用的模型档位（如 `Whisper: medium / Qwen: 7b`），便于排查精度问题
- [x] **首次切换更高档位时**：自动触发模型下载，复用 F7 的进度展示

---

### V1.1 — 增强体验

- [ ] **后台预翻译**：转写完成后自动翻译用户偏好语言
- [ ] **字幕导出**：下载 VTT / SRT / ASS 格式
- [ ] **专业术语词表**：用户可上传术语 prompt 提升转写准确率
- [ ] **历史记录**：左侧栏显示最近处理过的视频

> 注：批量处理已在 F1 通过 FIFO 队列实现，不再单列；**字幕编辑**推迟到 V2.0+，编辑后是否级联重翻待届时决策

---

### V2.0 — 进阶（可选）

- [ ] **字幕编辑**：手动修正个别错误条目（原文/译文均可编辑；级联策略届时决策）
- [ ] **双语字幕**：原文 + 译文同时显示（上下两行）
- [ ] **AI 摘要**：基于字幕生成视频概要 / 章节
- [ ] **关键词搜索**：在字幕里全文搜索并跳转
- [ ] **说话人分离**（diarization）：标记不同发言人
- [ ] **桌面应用打包**：Tauri / Electron 打包成 .dmg / .exe

---

## 四、非功能需求

### 性能

| 场景 | 目标 |
|---|---|
| 1 小时视频转写（M2 Mac） | ≤ 10 分钟 |
| 1 小时视频翻译单语言（M2 Mac） | ≤ 5 分钟 |
| 首段字幕可见时间（流式） | ≤ 60 秒 |
| 已缓存视频打开 | ≤ 2 秒 |
| 已翻译语言切换 | 即时（< 100ms） |

### 资源占用

- 内存峰值 ≤ 10GB
- 磁盘：模型文件 ~8GB，单视频缓存 < 5MB
- 最低运行配置：16GB RAM

### 可用性

- 主流浏览器：Chrome / Edge / Safari 最新版
- 操作系统：macOS / Windows / Linux
- 不依赖 GPU（有 GPU 更快）

### 国际化（UI 文案）

- **集成 `@nuxtjs/i18n`**，初始支持 `zh-CN` 与 `en-US` 两份 locale 文件
- **默认语言**：根据 `navigator.language` 自动选择；中文系（zh-*）→ `zh-CN`，其余 → `en-US`
- **手动切换**：UI 顶部右侧语言选择器（不放设置深处），切换实时生效并持久化到 localStorage
- **i18n key 命名**：按页面/组件分组（如 `player.subtitle.menu.switch`），便于扩展
- **Key 提取规范**：所有用户可见文案必须走 `t()`，禁止硬编码中文/英文（ESLint 规则约束）
- **预留扩展位**：键值结构兼容未来加日/韩/西/法等语言，只需补翻译文件，无需改代码

### 可观测性

- **结构化日志**：所有后端事件以 JSONL 格式写入 `~/.subcast/logs/YYYY-MM-DD.jsonl`，按天滚动，保留最近 14 天
  - 字段：`{ts, level, requestId, taskId?, event, msg, ...payload}`
  - 敏感字段（视频原始路径、文件名）默认脱敏（hash 化），可在设置里开「调试模式」保留原文
- **错误详情抽屉**：UI 任何报错（toast / banner）都带「展开详情」按钮，显示完整 error stack + requestId，方便用户截图反馈
- **诊断包导出**：设置页「帮助 → 导出诊断包」按钮，一键打包成 `subcast-diagnostic-{date}.zip`，内含：
  - 最近 7 天 JSONL 日志（自动脱敏）
  - 用户配置（去除任何路径信息）
  - 硬件探测结果（OS/CPU/RAM/GPU 型号）
  - 已安装模型列表与版本
  - 不含任何视频内容或字幕文本
- **遥测**：明确**不做**任何形式的远程上报；用户主动反馈走 GitHub Issue + 诊断包附件

### 安全 & 隐私

- 所有处理本地完成，无数据外传
- 不收集任何用户数据
- 不需要登录账号
- **网络绑定**：默认 `HOST=0.0.0.0`，局域网内任何设备可直接通过 `http://<本机IP>:3000` 访问
- **无认证**：信任本地可信网络（家庭 / 办公小组），不引入登录或 PIN
- **启动横幅**：UI 顶部展示「局域网访问 URL」（含本机 LAN IP，方便手机/Pad 扫码访问）
- **使用警示**：README 明确提示——若所在网络不可信（公共 WiFi / 共享办公），用户应自行通过防火墙限制端口

---

## 五、技术栈（已锁定）

### 前端
- **Nuxt 4**（App Router、Nitro server、SSR/SPA 双模可切）
- **Vue 3** + **TypeScript**（strict 模式，禁用 `any`）
- **Tailwind CSS**（设计系统基础）
- **shadcn-vue**（基于 Reka UI 的组件库；通过 `shadcn-nuxt` 模块集成，组件按需复制到 `app/components/ui/`）

### 后端 / 推理
- **Nuxt Nitro**（统一 server 路由，无独立 Node 服务）
- **whisper.cpp** via `nodejs-whisper`（本地转写）
- **Ollama** + `qwen2.5:7b`（本地翻译，HTTP 调用）

### 架构图

```
┌──────────────────────────────────────────────┐
│  浏览器                                       │
│   Nuxt 4 + Vue 3 + TS + Tailwind + shadcn   │
│   - <video> + <track> 原生字幕               │
│   - SSE 接收流式转写/翻译                    │
│   - Pinia 管理任务队列状态                   │
└──────────────────┬───────────────────────────┘
                   │ HTTP / SSE
┌──────────────────▼───────────────────────────┐
│  Nuxt Nitro (server/)                        │
│   - api/transcribe.post.ts   (SSE 流式)      │
│   - api/translate.post.ts    (SSE 流式)      │
│   - api/queue/*              (任务管理)      │
│   - api/cache/*              (缓存读写)      │
│   - api/health.get.ts        (依赖自检)      │
└──────────┬─────────────────────┬─────────────┘
           │                     │
   ┌───────▼─────────┐   ┌───────▼─────────┐
   │ whisper.cpp     │   │ Ollama          │
   │ (nodejs-whisper)│   │ qwen2.5:7b      │
   │ 转写            │   │ 翻译            │
   └─────────────────┘   └─────────────────┘
```

### 关键依赖

| 用途 | 库 |
|---|---|
| UI 组件 | `shadcn-nuxt` + `reka-ui` + `tailwindcss` |
| 图标 | `@iconify/vue` 或 `lucide-vue-next`（shadcn 默认） |
| 状态管理 | `@pinia/nuxt` |
| 国际化 | `@nuxtjs/i18n`（zh-CN / en-US） |
| 日志 | `pino`（Nitro 端，JSONL 输出 + 按天滚动） |
| 转写 | `nodejs-whisper`（封装 whisper.cpp） |
| 翻译调用 | 原生 `$fetch` → Ollama HTTP API（`/v1/chat/completions`） |
| 视频处理 | `fluent-ffmpeg` + `ffmpeg-static`（提取音轨、计算 SHA256） |
| VTT 解析 | `node-webvtt` 或自写（结构简单） |
| 流式推送 | Nitro 原生 SSE（`eventHandler` + `setResponseHeaders`） |
| 缓存 | `better-sqlite3`（任务队列、历史、断点 chunk 索引） + 文件系统（VTT/视频） |
| 工具 | `zod`（API 入参校验）、`defu`（配置合并）、`ofetch`（自动有了） |

### shadcn-vue 初始化

```bash
pnpm dlx shadcn-vue@latest init
# 选择 Nuxt → TypeScript → 默认主题 → 组件目录 app/components/ui

# 按需添加组件
pnpm dlx shadcn-vue@latest add button dialog progress dropdown-menu \
  toast tooltip scroll-area separator badge alert
```

### 必备 shadcn 组件清单（MVP）

| 组件 | 用途 |
|---|---|
| `button` | 通用按钮 |
| `progress` | 转写/翻译进度条 |
| `dropdown-menu` | 字幕语言切换菜单 |
| `dialog` | 设置面板、清缓存确认 |
| `alert` | 依赖未就绪横幅、错误提示 |
| `badge` | 任务状态标签（等待中/转写中/完成） |
| `scroll-area` | 任务队列列表、历史记录滚动容器 |
| `tooltip` | 字幕条目悬浮提示 |
| `separator` | 布局分隔 |
| `toast` (sonner) | 全局通知（断点恢复、缓存清理完成等） |

---

## 六、用户流程

### 首次使用

```
1. 用户访问 http://localhost:3000
2. 拖入视频文件
3. 系统计算 SHA256，发现无缓存
4. 启动转写 → 30 秒后开始显示字幕，可立即播放
5. 转写持续进行（后台），用户可正常观看
6. 转写完成，字幕菜单可见「原文 ✓」
7. 用户点击「中文」→ 触发翻译
8. 翻译完成，字幕实时切换为中文
```

### 二次访问同一视频

```
1. 用户拖入视频
2. SHA256 命中缓存
3. 直接加载 VTT，0 秒进入播放
4. 字幕菜单显示已缓存的所有语言
```

---

## 七、目录结构（建议）

```
subcast/
├── REQUIREMENTS.md
├── README.md
├── package.json
├── nuxt.config.ts                # 注册 shadcn-nuxt / @pinia/nuxt / @nuxtjs/tailwindcss
├── tailwind.config.ts
├── components.json               # shadcn-vue 配置
├── app/
│   ├── pages/
│   │   ├── index.vue             # 主页（上传 + 历史 + 队列）
│   │   └── player/[hash].vue     # 播放器页（按 SHA256 路由）
│   ├── components/
│   │   ├── ui/                   # shadcn-vue 自动生成（button/dialog/...）
│   │   ├── video-player.vue
│   │   ├── subtitle-menu.vue     # 用 dropdown-menu
│   │   ├── upload-dropzone.vue
│   │   ├── task-queue.vue        # 用 scroll-area + badge
│   │   ├── health-banner.vue     # 用 alert
│   │   └── history-list.vue
│   ├── composables/
│   │   ├── useTranscribe.ts      # SSE 客户端封装
│   │   ├── useTranslate.ts
│   │   ├── useTaskQueue.ts
│   │   └── useHealth.ts
│   ├── stores/
│   │   ├── useTaskStore.ts       # Pinia：队列状态
│   │   └── useHealthStore.ts     # Pinia：依赖检测结果
│   ├── lib/
│   │   └── utils.ts              # shadcn-vue 标配 cn() 工具
│   └── assets/
│       └── css/
│           └── tailwind.css
├── server/
│   ├── api/
│   │   ├── upload.post.ts        # 上传 + 拷贝到缓存 + 入队
│   │   ├── transcribe.get.ts     # SSE 流式（按 hash）
│   │   ├── translate.post.ts     # SSE 流式
│   │   ├── queue/
│   │   │   ├── list.get.ts
│   │   │   └── [id]/cancel.delete.ts
│   │   ├── cache/
│   │   │   ├── list.get.ts       # 历史记录
│   │   │   ├── [hash].get.ts
│   │   │   └── clear.delete.ts
│   │   └── health.get.ts         # 依赖自检
│   ├── utils/
│   │   ├── whisper.ts            # nodejs-whisper 封装
│   │   ├── ollama.ts             # 翻译 prompt + 滑动窗口
│   │   ├── vtt.ts                # 解析 / 合并 / 序列化
│   │   ├── ffmpeg.ts             # 提取音轨 + SHA256
│   │   ├── db.ts                 # better-sqlite3 单例
│   │   ├── queue.ts              # FIFO 任务调度器
│   │   └── cache.ts              # 文件系统缓存读写
│   ├── schemas/                  # zod 入参校验
│   └── plugins/
│       └── 00.ensure-models.ts   # 启动检测 Ollama / Whisper
├── scripts/
│   ├── setup.sh                  # 一键安装 ollama + 拉模型
│   └── download-whisper-model.sh
└── docs/
    ├── ARCHITECTURE.md
    └── DEPLOYMENT.md
```

---

## 八、里程碑

| 阶段 | 周期 | 产出 |
|---|---|---|
| **M1：技术验证** | 1 周 | whisper.cpp + Ollama 跑通转写/翻译 |
| **M2：MVP** | 2-3 周 | F1-F6 全部完成，本地可用 |
| **M3：体验打磨** | 1-2 周 | 流式优化 + 缓存 + UI 细节 |
| **M4：V1.1 增强** | 2 周 | 编辑、导出、术语词表 |
| **M5：桌面打包** | 1 周 | Tauri 打包跨平台分发 |

---

## 九、待决策项

- [x] ~~选 Nuxt 4 还是 Vite + Vue~~ → **Nuxt 4 + TS + Tailwind + shadcn-vue**（已锁定）
- [x] ~~缓存存储：文件系统 vs SQLite~~ → **SQLite（better-sqlite3）+ 文件系统混合**（已锁定）
- [x] ~~翻译模型：Qwen2.5:7b vs 14b~~ → **硬件自适应**（见 F8），用户可手动切换
- [ ] 是否做桌面应用：Tauri（轻量）vs Electron（生态全）
- [ ] LICENSE：MIT / Apache 2.0 / GPL
- [x] ~~UI 界面语言~~ → **中英双语自动检测**（`@nuxtjs/i18n`，已锁定）

---

## 十、风险与对策

| 风险 | 对策 |
|---|---|
| Ollama 未安装 | 启动时检测，给出明确安装指引 |
| Whisper 模型未下载 | `nodejs-whisper` 自动下载，进度可见 |
| 长视频内存溢出 | 分块处理，限制并发 |
| 转写中途崩溃/关闭 | chunk 级持久化，下次打开自动从断点续传 |
| 翻译模型 hallucinate（产生不存在的字幕条目） | 严格校验输出条数 = 输入条数，否则重试 |
| 用户机器性能不够 | 提供 base/small/medium/large 模型档位选择 |

---

**文档版本**：v0.1  
**创建日期**：2026-05-09  
**下次评审**：M1 完成后
