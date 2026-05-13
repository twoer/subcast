# Subcast 桌面客户端打包方案

> 状态：草案 v5 | 日期：2026-05-12
>
> v5 在 v4 基础上加入 Q34-Q36 三项数据管理决策（Whisper 模型扫描复用 / Qwen 已装检测 / 不迁移 web 版数据）。共 36 项决策。
> 历次差异见底部 "Changelog"。

## 一、项目现状

Subcast 是本地优先的多语言字幕播放器：用户拖入视频文件后，通过本地 Whisper 转录、本地 Ollama (Qwen 2.5) 翻译，实现完全离线的字幕生成与观看体验。

> **首次配置需要联网**：完成 Whisper 模型 + Ollama 安装 + Qwen 模型下载后，所有后续转写翻译完全本地，无任何数据外发。

### 1.1 技术栈

| 层级 | 技术 | 桌面化挑战 |
|------|------|-----------|
| 前端 | Nuxt 4 + Vue 3 + Tailwind + shadcn-vue | 需嵌入 WebView；切 SPA 模式 |
| 服务端 | Nitro (h3) | 主进程 in-process 跑 |
| 数据库 | better-sqlite3 (native addon) | 每次升 Electron 都要 electron-rebuild |
| 转录 | whisper.cpp (spawn `whisper-cli`) | 抛弃 `nodejs-whisper` 源码编译，改 CI 预编译固定 tag |
| 翻译/摘要 | Ollama HTTP (`localhost:11434`) | **不 bundle**，引导用户外装 |
| 音频处理 | ffmpeg/ffprobe | `ffmpeg-static`（LGPL 构建） |

### 1.2 外部运行时依赖

- **Node.js 22+** — Electron 内置
- **ffmpeg + ffprobe** — `ffmpeg-static` 通过 `extraResources` 内嵌
- **whisper-cli** — CI 矩阵预编译，固定 whisper.cpp tag（开工时确认 `v1.7.x` latest stable）
- **better-sqlite3** — `electron-rebuild` 在每个平台 CI runner 上构建
- **Ollama** — 独立产品，**用户自装**

### 1.3 数据目录变更

| 现状（CLI / dev） | 桌面版 |
|------|--------|
| `$SUBCAST_HOME` 或 `~/.subcast/` | `app.getPath('userData')`，主进程注入 `SUBCAST_HOME` |
| macOS：`~/.subcast/` | macOS：`~/Library/Application Support/Subcast/` |
| Windows：`~/.subcast/` | Windows：`%APPDATA%/Subcast/` |

**与 web 版的数据关系（决策 36）**：桌面版**不导入**任何 web 版（`~/.subcast/`）的数据。桌面 app 是独立产品，首装即全新开始。开发期 web 版的旧数据不会被自动迁移，也不会被破坏（用户自己想用可手动 copy）。

> 例外：Whisper 模型文件可以通过 § 5.7 的扫描复用流程被识别并软链接/复制过来，避免重复下载。这条不算"迁移"，是"复用单一模型文件"。

---

## 〇、设计决策（共 33 项，已定）

按主题分组。完整列表见各小节末尾的"决策连带影响"。

### 0.1 核心技术（Q1-Q9）

| # | 项 | 决策 |
|---|---|---|
| 1 | App ID / Bundle ID | `io.github.twoer.subcast` |
| 2 | 应用图标 | 复用 `public/favicon.svg`，构建时渲染 `icon.icns` + `icon.ico`（多分辨率） |
| 3 | 首次运行默认 Whisper 模型 | `base`（148MB），用户可改；模型列表去掉 large-v3，改 large-v3-turbo |
| 4 | 本地 API 鉴权 | Session token + 端口 `51301` 首选，冲突回退随机 |
| 5 | 平台支持 | 仅 **macOS arm64** + **Windows x64** |
| 6 | 分发渠道 | GitHub Releases 起步；后期加国内 OSS 镜像 |
| 7 | 版本策略 | SemVer 单 stable 渠道，起步版本 `0.1.0` |
| 8 | 崩溃 / 错误上报 | 纯本地日志 + 菜单 **"Export Diagnostics..."**（Help 菜单 + 托盘菜单）|
| 9 | 签名预算 | **$0/年**：macOS 不签名，Windows self-signed |

### 0.2 产品命名与外观（Q10-Q14, Q19）

| # | 项 | 决策 |
|---|---|---|
| 10 | 产品显示名 | **Subcast** |
| 10b | 产品中文描述 | **"免费 · 离线 · 大模型 — 音视频转写翻译"**（About 框副标题、安装器副标题、Dock 长按提示） |
| 11 | 关闭窗口（×/⌘W/Alt+F4）行为 | **隐藏到托盘**（保留任务运行）；真退出靠 ⌘Q/Ctrl+Q 或托盘菜单 Quit |
| 12 | 文件类型关联 | **可选关联，不抢占默认** — `fileAssociations` 注册 mp4/mkv/mov/webm 等；用户右键"用 Subcast 打开"才能用 |
| 13 | 开源 license | **AGPL v3** — `LICENSE` 文件 + `package.json` `"license": "AGPL-3.0-or-later"` + 每文件 SPDX header |
| 14 | 默认窗口大小 | **首启最大化** + 后续启动 `electron-window-state` 记忆 |
| 19 | 主题 | **永远暗色** — 主进程注入 `<html class="dark">`，不监听系统主题 |

### 0.3 用户体验（Q15-Q18）

| # | 项 | 决策 |
|---|---|---|
| 15 | 开机自启 | **不提供**该选项 |
| 16 | 首次运行向导完成后的空状态 | **空库 + 拖拽提示**（与 web 版一致） |
| 17 | 启动 splash screen | **不要**，主窗口立刻出，内容渐进显示 |
| 18 | 升级后 "What's new" UI | **静默更新**，不展示 release notes（用户去 GitHub Releases 自查） |

### 0.4 启动 / 恢复 / 错误（Q20-Q24）

| # | 项 | 决策 |
|---|---|---|
| 20 | 多实例 | **强制单实例**（`app.requestSingleInstanceLock()`）；二次启动触发已有窗口聚焦 |
| 21 | 上次崩溃后僵尸任务 | **按类型分**：Transcribe 自动恢复（chunk-level resume 已有）；Translate/Insight 标记 `failed`，用户主动重试 |
| 22 | 磁盘空间预检 | **模型下载硬阻塞**（`size × 1.5` 阈值）+ **视频处理仅警告**（`100MB` 阈值）|
| 23 | Nitro 启动失败 UX | **友好对话框** [打开日志] [报告问题] [退出] 三按钮 |
| 24 | 卸载 userData 处理 | macOS 标准（拖废纸篓只删 .app）；Windows NSIS 弹窗 "是否同时删除您的数据" **默认否** |

### 0.5 构建 / 下载（Q25-Q28）

| # | 项 | 决策 |
|---|---|---|
| 25 | whisper.cpp 版本锁定 | 固定到 tag（开工时确认 `v1.7.x`），升级 = 人工 review + 跑回归 |
| 26 | 模型下载顺序 | **部分并行**：Step 1 Whisper 下载 + Step 2 Ollama 安装可同时进行；Step 3 Qwen pull 必须等 Ollama running |
| 27 | Hugging Face 镜像 | 默认 HF + UI 按钮 **"切换到 hf-mirror.com"** |
| 28 | 下载进度显示 | **百分比 + 字节数 + 估算剩余时间**（速率不显示，按最近 5 秒平均算） |

### 0.6 菜单与一致性（Q29-Q33）

| # | 项 | 决策 |
|---|---|---|
| 29 | 应用菜单结构 | **极简**：macOS = App menu + Help menu（其它菜单不要）；Windows = 完全隐藏顶部菜单条，所有菜单类操作迁到托盘右键菜单 |
| 30 | About 对话框 | **完整版** — Logo + 副标题 + 版本 + "100% 本地运行 · 零数据外发" + 依赖致谢 + AGPL link + 仓库/License/报告问题三按钮 |
| 31 | "首次需联网"明示 | README 顶部 callout + Setup Wizard 顶部副标题 双重提示 |
| 32 | i18n 范围 | **en + zh-CN 双语全覆盖**（README + 应用 UI 同步） |
| 33 | 系统快捷键映射 | ⌘W/Alt+F4 → 隐藏托盘；⌘Q/Ctrl+Q → 真退出；⌘, → 偏好设置；⌘O 不绑定 |

### 0.7 数据管理与复用（Q34-Q36）

| # | 项 | 决策 |
|---|---|---|
| 34 | Whisper 模型存储位置 + 是否扫描复用用户已有模型 | **私有目录 + 首装扫描**：默认存 `userData/models/whisper/`；Setup Wizard Step 1 扫描常见路径（`~/.subcast/.../models/`、`~/whisper.cpp/models/`、Aiko 等），发现匹配的 `ggml-*.bin` 弹窗 "[复制 / 软链接 / 忽略]" |
| 35 | 用户已有 Ollama + Qwen 模型 | **检测 + 显示状态**：Wizard Step 3 列出 qwen2.5:3b / 7b / 14b 档位，已装的型号旁标 ✓；默认选已装的（一键完成）；选未装的走下载 |
| 36 | Web 版 (`~/.subcast/`) 数据迁移 | **不迁移**。桌面版独立 userData，全新开始。Whisper 模型例外（走决策 34 扫描复用） |

---

## 一⌥、决策 9 的连带影响（重要）

不签名带来三个用户体验断点，必须在产品里**显式处理**：

1. **macOS 首次打开** — Gatekeeper 拦截，分两条路径：
   - **macOS 14 及更早**：右键 .app → "Open" → 弹窗 "Open"
   - **macOS 15+ Sequoia**：右键路径被收紧。系统设置 → 隐私与安全性 → 找到 "Subcast 被阻止" → 点 "仍要打开"
   - **应对**：README + 应用内 Help 必须有两套截图，分别覆盖两条路径
2. **macOS 自动更新失效** — `electron-updater` 在未签 .app 上跑不通签名连续性校验
   - **应对**：替换为"手动检查"模式。菜单 `Help → Check for Updates...` + 启动后 5s 静默检查（仅"有新版本"时弹）
3. **Windows SmartScreen 警告** — self-signed 不被 Windows 信任
   - **应对**：README 提供截图引导（"More info → Run anyway"）；electron-updater 在 Windows 上仍可工作（self-signed 不阻碍 updater 本身）

---

## 二、Phase 0 — 4 个关键技术决策（已定，详见 § 0.1）

在写一行 Electron 代码前，这四条已定。本节解释每条的理由。

### 2.1 Nitro 跑在哪里？— **主进程 in-process**

主进程 `import('./.output/server/index.mjs')`，Nitro 监听本地端口。

**理由**：
- 简单：不用关心子进程崩溃恢复、stdout 转发
- 共享内存：主进程要管托盘、菜单、Ollama 检测，与 Nitro 内任务管理器在同一 JS context 通信
- 缺点是主进程崩溃面变大，但单用户桌面应用不是 SaaS，崩了重启即可

**端口策略（决策 4）**：首选 `51301`，`EADDRINUSE` 时 `server.listen(0)` 回退随机。主进程拿到实际端口后注入 BrowserWindow URL。

### 2.2 前端 SSR 还是 SPA？— **SPA**

`nuxt.config.ts` 加 `ssr: false`，Nitro 只剩 `/api/*`。HTML/JS 当成静态资源由 Electron `loadURL` 加载。

**理由**：桌面版无 SEO 需求；SPA 无 hydration mismatch。

**Nuxt 配置**：保持 web 版 SSR 不变。桌面构建用环境变量切换或单独 `nuxt.desktop.config.ts`。

### 2.3 whisper-cli 二进制从哪来？— **CI 矩阵预编译，固定 tag**

CI matrix（依据决策 5，仅 2 个平台）：

```yaml
matrix:
  include:
    - os: macos-14       # arm64
    - os: windows-latest # x64
```

每个 runner clone whisper.cpp 的 **固定 tag**（决策 25：`v1.7.x latest，开工时确认`），`cmake --build . --target whisper-cli`，产物 → `binaries/<platform>/whisper-cli[.exe]` → `extraResources`。

**加速决策**：
- macOS：Metal 默认开（`-DGGML_METAL=ON`）
- Windows：暂不开 CUDA（依赖巨大且用户没显卡跑不了）；只走 CPU

### 2.4 Ollama 怎么办？— **不 bundle，引导用户外装**

Ollama macOS .app 800MB+，bundle 进去安装包飙到 1GB+ 还没装模型。

**做法**：首次运行向导检测 → 未装则 `shell.openExternal('https://ollama.com/download')` + 等待用户回来 → 检测到了再继续。

**关键**：**只检测，不 spawn 用户的 ollama 进程**。Ollama 自己的 .app 由 launchd 管理；我们不接管。

---

## 三、整体架构

```
┌────────────────────────────────────────────────────┐
│ Electron Main Process (Node.js)                    │
│                                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │ in-process Nitro server (`.output/server`)  │   │
│  │   ├── /api/*  ← 与 web 版完全共享           │   │
│  │   ├── 鉴权 middleware（决策 4）             │   │
│  │   ├── 启动恢复 plugin（决策 21）            │   │
│  │   └── better-sqlite3 (electron-rebuilt)     │   │
│  └─────────────────────────────────────────────┘   │
│                                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │ Desktop-only services                       │   │
│  │   ├── ollamaDetector (检测,不启停)          │   │
│  │   ├── modelManager (Whisper 下载/校验)      │   │
│  │   ├── firstRunWizard (检测缺失 → 引导)      │   │
│  │   ├── updater (Win: electron-updater /      │   │
│  │   │            macOS: manualUpdater)        │   │
│  │   ├── trayMenu (菜单类操作的入口)           │   │
│  │   ├── singleInstanceLock                    │   │
│  │   └── diagnostics (Export Diagnostics)      │   │
│  └─────────────────────────────────────────────┘   │
│                                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │ Preload (contextIsolation = true)           │   │
│  │   └── window.subcast = {                    │   │
│  │         isDesktop, apiToken, platform,      │   │
│  │         appVersion, ...                     │   │
│  │       }                                     │   │
│  └─────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
                          ↕ loadURL("http://localhost:<port>?token=...")
┌────────────────────────────────────────────────────┐
│ BrowserWindow — Nuxt SPA (强制 dark mode)          │
│   - 通过 window.subcast 检测桌面环境               │
│   - fetch 自动附 x-subcast-token header            │
│   - 调用 /api/* 与 Nitro 通信                      │
└────────────────────────────────────────────────────┘
                          ↕ HTTP localhost
┌────────────────────────────────────────────────────┐
│ External: Ollama (用户自装，独立 launchd 服务)     │
└────────────────────────────────────────────────────┘
```

### 3.1 内嵌资源

| 路径 | 来源 | 大小（约）|
|------|------|----------|
| `resources/app.asar` | Nitro 构建 + 前端 SPA | 30-50 MB |
| `resources/ffmpeg`, `resources/ffprobe` | `ffmpeg-static` npm 包 | 50-80 MB |
| `resources/whisper-cli` | CI 矩阵产物（whisper.cpp `v1.7.x`） | 5-10 MB |
| `resources/node_modules/better-sqlite3/...node` | electron-rebuild 产物 | 1-2 MB |
| Electron runtime | 内置 | 150-180 MB |

**总安装包**：macOS arm64 约 **240-280 MB**，Windows x64 约 **220-260 MB**。模型不进包，下载到 userData。

### 3.2 ffmpeg 许可证

`ffmpeg-static` npm 包默认是 LGPL 构建，**不含**显式 GPL 组件（libx264 等编码器）。Subcast 只做解码（probe duration、extract WAV），LGPL 够用。

**注意**：未来要做导出/转码（编码 H.264 等）→ 换更全的 ffmpeg 构建会引入 GPL，需提供源码链接。当前路径不需要。

---

## 四、共享代码 + 桌面分支

### 4.1 仓库结构

```
subcast/
├── app/                    # Nuxt 前端（web + 桌面共享）
├── server/                 # Nitro 后端（web + 桌面共享）
├── i18n/                   # 国际化（共享）
├── desktop/                # 桌面专用（新增）
│   ├── main.ts             # Electron 主进程入口
│   ├── preload.ts          # 注入 window.subcast
│   ├── nitroEmbed.ts       # 主进程内启动 Nitro
│   ├── ollamaDetector.ts   # Ollama 检测（不启停）
│   ├── manualUpdater.ts    # macOS 手动 Check for Updates
│   ├── trayMenu.ts         # 系统托盘菜单
│   ├── diagnostics.ts      # Export Diagnostics 打包 zip
│   ├── diskSpace.ts        # 磁盘空间预检
│   ├── modelManager/
│   │   ├── whisper.ts      # Whisper 模型下载/校验
│   │   └── downloader.ts   # 通用断点续传（含 HF 镜像切换）
│   └── platform/
│       ├── darwin.ts
│       └── win32.ts
├── binaries/               # CI 产物落地（.gitignore）
│   ├── darwin-arm64/whisper-cli
│   └── win32-x64/whisper-cli.exe
├── assets/                 # 图标
│   ├── icon.icns           # 由 favicon.svg 渲染（多分辨率 16-1024）
│   └── icon.ico            # 同上
├── electron-builder.config.json5
├── LICENSE                 # AGPL-3.0
└── README.md / README.zh.md
```

### 4.2 运行时检测（前端）

**preload.ts**：

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('subcast', {
  isDesktop: true,
  platform: process.platform,
  appVersion: process.env.npm_package_version,
  apiToken: process.env.SUBCAST_API_TOKEN,
});
```

**前端检测**（`app/composables/useDesktop.ts`，新增）：

```ts
export function useDesktop() {
  if (typeof window === 'undefined') return { isDesktop: false, platform: null };
  const api = (window as Window & {
    subcast?: { isDesktop: boolean; platform: string };
  }).subcast;
  return {
    isDesktop: !!api?.isDesktop,
    platform: api?.platform ?? null,
  };
}
```

**Nitro 端检测**：环境变量 `SUBCAST_DESKTOP=true` 由主进程在 `import('./.output/server/index.mjs')` 之前设置。

### 4.3 差异点清单

| 功能 | Web 版 | 桌面版 |
|------|--------|--------|
| Ollama | 不管理 | **只检测**（不 spawn 用户进程） |
| 模型管理 UI | 隐藏 | 显示 |
| Whisper 二进制位置 | `node_modules/nodejs-whisper/...` | `process.resourcesPath/whisper-cli` |
| Whisper 模型位置 | `node_modules/.../models` | `app.getPath('userData')/models/whisper/` |
| ffmpeg | 系统 PATH | `process.resourcesPath/ffmpeg` |
| 数据目录 | `~/.subcast/` | `app.getPath('userData')` |
| 首次运行向导 | 不需要 | 必需 |
| 自动更新 | 不需要 | Windows: electron-updater；macOS: 手动 Check for Updates |
| 主题 | 跟系统 | 强制暗色 |
| 文件关联 | 不可 | 可选注册（决策 12） |
| API 鉴权 | 无 | Session token（决策 4） |

### 4.4 服务端条件逻辑示例

```ts
// server/utils/whisperPaths.ts （现有文件改造）
import { join } from 'node:path';

const IS_DESKTOP = process.env.SUBCAST_DESKTOP === 'true';

export const WHISPER_CLI_PATH = IS_DESKTOP
  ? join(process.resourcesPath!, 'whisper-cli' + (process.platform === 'win32' ? '.exe' : ''))
  : join(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'build', 'bin', 'whisper-cli');

export const WHISPER_MODELS_DIR = IS_DESKTOP
  ? join(process.env.SUBCAST_HOME!, 'models', 'whisper')
  : join(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'models');
```

---

## 五、首次运行向导

### 5.1 总流程

```
App 启动
  │
  ├── 1. 主进程：申请单实例锁（决策 20）
  │     └── 失败 → 唤醒已有实例 + 自身退出
  │
  ├── 2. 主进程：启动 Nitro（in-process）
  │     ├── 失败 → 友好对话框（决策 23）
  │     └── 成功 → Nitro 监听 51301/随机
  │
  ├── 3. 主进程：注入 SUBCAST_API_TOKEN、SUBCAST_DESKTOP=true
  │     └── 启动恢复 plugin 处理僵尸任务（决策 21）
  │
  ├── 4. BrowserWindow.loadURL(http://localhost:<port>/setup-check)
  │     /setup-check 检测：
  │       ├── ffmpeg / whisper-cli / better-sqlite3 (应该都在,内嵌)
  │       ├── 扫描 userData/models/whisper/ → 至少一个 .bin?
  │       └── 探测 localhost:11434 → Ollama running?
  │       (决策 36：不再探测旧 ~/.subcast/,数据完全独立)
  │
  ├── 5. 若全部 OK → 跳转主界面（空库或库内已有视频）
  │
  └── 6. 若缺失 → 跳转 /setup-wizard
        Setup Wizard 副标题:
        "准备 Subcast（首次配置需要联网下载约 5GB 模型）"
        ├── Step 1: Whisper 模型选择 + 下载
        │            （后台跑,允许用户进 Step 2）
        ├── Step 2: Ollama 检测 + 引导外装
        └── Step 3: Qwen 模型选择 + 拉取
```

### 5.2 Whisper 模型下载

#### 模型列表（决策 3）

`large-v3-turbo`（2024 年 10 月发布）速度比 `large-v3` 快约 8 倍、体积小一半，质量差距小，是顶级档的正确选择。**不再列 `large-v3`**。

| 模型 | 大小 | 定位 |
|------|------|------|
| tiny | ~77 MB | 短测试，最快 |
| **base** ★ 默认 | ~148 MB | 均衡推荐 |
| small | ~466 MB | 质量更好 |
| medium | ~1.5 GB | 高质量 |
| large-v3-turbo | ~1.6 GB | 顶级，速度可接受 |

#### 首装向导 UI

- 单选列表，`base` 默认勾选，旁边贴 **"Recommended"** 标签（i18n）
- 用户可**跳过**这一步（"稍后下载"）；跳过后主界面显示"未配置转录模型"提示卡片，转录按钮禁用
- 进度显示决策 28：百分比 + 字节数 + 估算剩余时间
- "切换到 hf-mirror.com" 按钮（决策 27，下文 § 5.6 详述）

#### 实现骨架

```ts
// desktop/modelManager/whisper.ts
type WhisperModelName = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

interface WhisperModel {
  name: WhisperModelName;
  sizeBytes: number;
  url: string;     // Hugging Face URL
  mirrorUrl: string; // hf-mirror.com 备用源
  sha256: string;  // 首次合并前手动 shasum -a 256 一遍
}

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const MIRROR_BASE = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main';

const WHISPER_MODELS: WhisperModel[] = [
  { name: 'tiny',            sizeBytes:   77_000_000, url: `${HF_BASE}/ggml-tiny.bin`,            mirrorUrl: `${MIRROR_BASE}/ggml-tiny.bin`,            sha256: '...' },
  { name: 'base',            sizeBytes:  148_000_000, url: `${HF_BASE}/ggml-base.bin`,            mirrorUrl: `${MIRROR_BASE}/ggml-base.bin`,            sha256: '...' },
  { name: 'small',           sizeBytes:  466_000_000, url: `${HF_BASE}/ggml-small.bin`,           mirrorUrl: `${MIRROR_BASE}/ggml-small.bin`,           sha256: '...' },
  { name: 'medium',          sizeBytes: 1_500_000_000, url: `${HF_BASE}/ggml-medium.bin`,          mirrorUrl: `${MIRROR_BASE}/ggml-medium.bin`,          sha256: '...' },
  { name: 'large-v3-turbo',  sizeBytes: 1_620_000_000, url: `${HF_BASE}/ggml-large-v3-turbo.bin`, mirrorUrl: `${MIRROR_BASE}/ggml-large-v3-turbo.bin`, sha256: '...' },
];

const DEFAULT_MODEL: WhisperModelName = 'base';
```

### 5.3 Ollama 引导 — 只检测，不 spawn

```ts
// desktop/ollamaDetector.ts
import { shell } from 'electron';
import { existsSync } from 'node:fs';

async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/version', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function detectOllamaState(): Promise<'running' | 'installed-not-running' | 'needs-install'> {
  if (await probeOllama()) return 'running';

  // 仅检测本机 Ollama 二进制存在性
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Ollama.app/Contents/MacOS/ollama', '/usr/local/bin/ollama']
    : ['C:\\Program Files\\Ollama\\ollama.exe'];

  for (const p of candidates) {
    if (existsSync(p)) return 'installed-not-running';
  }
  return 'needs-install';
}

// ⚠️ 关键：我们不 spawn 用户自装的 Ollama
// Ollama 自己的 .app 有 launchd 服务管理，我们只检测、引导，不接管其生命周期
async function guideUserToInstall(): Promise<void> {
  await shell.openExternal('https://ollama.com/download');
  // 用户回来后在向导 Step 2 点 "我已安装" → 重新 probeOllama() 轮询
}
```

### 5.4 Qwen 模型下载 + 已装检测（决策 35）

Step 3 进入时先列已装模型：

```ts
// desktop/modelManager/qwen.ts
async function listInstalledOllamaModels(): Promise<string[]> {
  const res = await fetch('http://localhost:11434/api/tags');
  const data = await res.json() as { models: Array<{ name: string }> };
  return data.models.map((m) => m.name); // e.g. ['qwen2.5:7b', 'llama3.1:8b']
}
```

#### UI

```
Step 3/3 — 选择 AI 模型
─────────────────────────────────────
 ○ qwen2.5:3b   (1.9 GB)
 ● qwen2.5:7b   (4.7 GB) ✓ 已就绪
 ○ qwen2.5:14b  (9.0 GB)

默认选中已就绪的型号。选未就绪的会走下载。

           [上一步] [完成]
─────────────────────────────────────
```

- 用户已装 7b → 默认选 7b → 点完成 = 一键结束
- 用户已装 14b 但没 7b → 默认选 14b（已就绪的）；可改选 7b（走下载）
- 全没装 → 默认选 7b（推荐档），点完成 = 走下载

#### 下载实现

走 Ollama HTTP API，解析 NDJSON 流：

```ts
async function pullQwenModel(variant: '3b' | '7b' | '14b', onProgress: (pct: number) => void) {
  const res = await fetch('http://localhost:11434/api/pull', {
    method: 'POST',
    body: JSON.stringify({ name: `qwen2.5:${variant}`, stream: true }),
  });
  // 解析 NDJSON 流，每行 { status, completed, total }
}
```

### 5.5 断点续传

通用下载器接 HTTP Range header，写入用 `createWriteStream({ flags: 'a' })` 追加。下载完做 SHA256 校验，失败删档重来。

### 5.6 下载流程详细设计（决策 26-28）

#### 顺序：部分并行

```
Step 1（用户选 Whisper 档位）→ Whisper 下载开始（后台）
   ↓ 同时显示进度,允许用户进入 Step 2
Step 2（Ollama 检测）
   - 检测到 running → 直接跳 Step 3
   - 未装 → "前往 ollama.com" + "我已安装" 按钮
     用户去网页装好回来点 "我已安装" → 轮询 probeOllama() 直到 running
   ↓ Whisper 在这期间大概率已下完
Step 3（用户选 Qwen 档位）→ Qwen pull 开始
   ↓ 进度条
全部完成 → 主界面
```

#### 下载源（决策 27：HF 镜像可手动切换）

| 项 | 默认源 | 备用源 | 用户切换 UI |
|---|---|---|---|
| Whisper 模型 | `huggingface.co/ggerganov/whisper.cpp` | `hf-mirror.com/ggerganov/whisper.cpp` | "切换到 hf-mirror.com" 按钮 |
| Ollama 本体 | `ollama.com/download` | 无 | — |
| Qwen 模型 | Ollama Registry（`registry.ollama.ai`） | Ollama 自己处理镜像 | — |

#### 进度显示（决策 28）

```
base.bin
[████████░░░░░░] 52%
77 MB / 148 MB · 约 30 秒剩余
[切换到 hf-mirror.com]
```

时间估算：取最近 **5 秒**的平均下载速率 × 剩余字节数。

### 5.7 Whisper 模型扫描复用（决策 34）

Setup Wizard **Step 1 开始时**先扫描以下路径找已有的 `ggml-*.bin`：

```ts
// desktop/modelManager/whisperScan.ts
const SCAN_PATHS = [
  // Subcast web 版（开发期数据）
  join(homedir(), '.subcast', 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'models'),
  // whisper.cpp 用户自编译
  join(homedir(), 'whisper.cpp', 'models'),
  // macOS: Aiko / Whisper Transcription 等套壳工具
  join(homedir(), 'Library', 'Application Support', 'com.aiko.app', 'models'),
  // 用户手动指定（输入框,可空）
];

async function scanExistingModels(): Promise<Array<{
  name: WhisperModelName;
  path: string;
  source: string;  // 'web版' / 'whisper.cpp' / 'Aiko' / '用户指定'
}>> {
  // 遍历每个路径,匹配 ggml-{tiny,base,small,medium,large-v3-turbo}.bin
  // SHA256 校验通过的算"可信任的模型文件"
}
```

#### 扫描结果 UI

```
Step 1/3 — 选择转录模型
─────────────────────────────────────
 ○ tiny           (77 MB)
 ● base ★ 推荐    (148 MB) 🔗 已存在于 ~/.subcast/.../models/
 ○ small          (466 MB)
 ○ medium         (1.5 GB)
 ○ large-v3-turbo (1.6 GB)

base.bin 已在你机器上检测到:
 ◉ 软链接（推荐,不占空间）
 ○ 复制到 Subcast 数据目录（4 MB,独立保留）
 ○ 忽略,从网络下载新的

              [跳过] [下一步 →]
─────────────────────────────────────
```

- **软链接**：`fs.symlinkSync(srcPath, destPath)` — macOS / Win 都支持，Subcast 看到的就是该文件；原文件删了 Subcast 也用不了
- **复制**：`fs.copyFileSync(srcPath, destPath)` — 占双倍空间，但独立保留
- **忽略**：从 HF 下载，覆盖任何同名文件

每次选档位 UI 都会重新查 SCAN_PATHS 中是否已存在；用户切换档位时实时刷新右侧"已存在"提示。

#### 用户手动指定路径

Step 1 右下角加一行 `[添加扫描路径...]` 按钮，弹系统文件夹选择器；选完后将该路径加入 SCAN_PATHS 并立即重扫。

---

## 六、关键技术细节

### 6.1 better-sqlite3 + Electron ABI

每次升级 Electron 都要重 build：

```bash
pnpm add -D electron-rebuild
npx electron-rebuild -f -w better-sqlite3
```

CI 矩阵（依据决策 5，仅 2 条）：

```yaml
matrix:
  include:
    - os: macos-14       # arm64
    - os: windows-latest # x64
```

### 6.2 macOS — 不签名路线（决策 9）

**当前路线：不申请 Apple Developer，不公证**。

#### 用户首装步骤 — 按系统版本两条路径

**macOS 14 及更早**：

1. 下载 `.dmg`，双击挂载
2. 拖 `Subcast.app` 到 `Applications/`
3. 在 `Applications/` 中**右键** → "Open"（不是双击）→ 弹窗中确认 "Open"
4. 之后双击即可，无需重复

**macOS 15+ Sequoia**（"右键 Open" 路径被收紧）：

1. 下载 `.dmg`，双击挂载
2. 拖 `Subcast.app` 到 `Applications/`
3. 双击 `Subcast.app` → 弹窗 "Apple cannot check..."，点 "Cancel"
4. 打开 **系统设置 → 隐私与安全性** → 滚到底部找到 "Subcast 被阻止" → 点 **"仍要打开"**
5. 重新双击 `Subcast.app` → 再次弹窗，点 "Open"
6. 之后双击即可

**应对**：README + 应用内 Help 必须有**两套截图**，按系统版本展示。

#### 配置

```jsonc
{
  "mac": {
    "target": ["dmg"],
    "icon": "assets/icon.icns",
    "identity": null            // 显式不签
  }
}
```

#### 后果：自动更新失效 → 见 § 6.4 manualUpdater

### 6.3 Windows — Self-signed 路线（决策 9）

#### 生成 self-signed 证书

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=Subcast (twoer)" `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(5)

Export-PfxCertificate -Cert $cert -FilePath subcast-codesign.pfx `
  -Password (ConvertTo-SecureString -String "your-passphrase" -Force -AsPlainText)
```

`.pfx` + passphrase → GitHub Actions Secrets。

⚠️ **证书有效期**：5 年到期后必须续期。续期后第一次发版的用户会被当作"完全不签"对待，SmartScreen 警告重置（reputation 清零）。

#### 用户首装

1. 下载 `.exe`，双击
2. SmartScreen 弹 "Windows protected your PC"
3. 点 **"More info"** → 显示 publisher "Subcast (twoer)"
4. 点 **"Run anyway"** → 进入安装器
5. 之后启动无障碍

#### electron-builder 配置

```jsonc
{
  "win": {
    "target": ["nsis"],
    "icon": "assets/icon.ico",
    "certificateFile": "${env.WIN_CSC_LINK}",
    "certificatePassword": "${env.WIN_CSC_KEY_PASSWORD}",
    "signingHashAlgorithms": ["sha256"]
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "deleteAppDataOnUninstall": false,    // 默认不删（决策 24）
    "include": "build/uninstaller.nsh"    // 自定义脚本加 "同时删除数据" checkbox
  }
}
```

### 6.4 自动更新 — 分平台

#### Windows：electron-updater 差分包

```jsonc
{
  "publish": {
    "provider": "github",
    "owner": "twoer",
    "repo": "subcast"
  }
}
```

检查时机：**启动时一次 + 每 6 小时一次**。差分典型 10-30MB。

#### macOS：手动 Check for Updates（决策 9 后果）

```ts
// desktop/manualUpdater.ts (macOS only)
async function checkForUpdates(silent = false): Promise<void> {
  const res = await fetch('https://api.github.com/repos/twoer/subcast/releases/latest');
  const release = await res.json() as { tag_name: string; html_url: string };
  const latest = release.tag_name.replace(/^v/, '');
  const current = app.getVersion();

  if (latest === current) {
    if (!silent) dialog.showMessageBox({ message: '已是最新版本' /* i18n */ });
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `发现新版本 ${latest}` /* i18n */,
    detail: `当前 ${current}，前往发布页查看更新内容并下载新版。`,
    buttons: ['打开下载页', '稍后'] /* i18n */,
    defaultId: 0,
  });
  if (response === 0) shell.openExternal(release.html_url);
}
```

触发：
- **菜单** `Help → Check for Updates...`（用户主动）
- **托盘菜单** `Check for Updates...`（用户主动）
- **启动后 5 秒静默检查一次**（仅"有新版本"时弹）

### 6.5 文件拖放 + sandbox

`contextIsolation: true` 下，前端不能直接拿 `File.path`。
**正确做法**：preload 暴露 `subcast.onFileDrop(callback)`；主进程接 `app.on('open-file')`（macOS）+ 主窗口 `dragenter/drop` 通过 IPC 转发。1-2 天开发量。

### 6.6 子进程清理

`app.on('before-quit')` 时：

```ts
import { transcribeQueue, translateQueue } from './.output/server/...';
import { abortAllInsightTasks } from './.output/server/utils/insightTasks';
transcribeQueue.cancelAll();
translateQueue.cancelAll();
abortAllInsightTasks();
// Ollama 用户进程不归我们管,不动
```

需要给 queue 加 `cancelAll()`、insightTasks 加 `abortAll()`（见 § 十 兼容性表）。

### 6.7 SSE 在 Electron 中

Nitro 的 SSE 端点走 EventSource，Electron BrowserWindow 默认支持，无特殊处理。

### 6.8 本地 API 鉴权 + 端口策略（决策 4）

#### Token 流程

```ts
// desktop/main.ts
import { randomUUID } from 'node:crypto';

const SESSION_TOKEN = randomUUID();
process.env.SUBCAST_API_TOKEN = SESSION_TOKEN;
process.env.SUBCAST_DESKTOP = 'true';

await import('./.output/server/index.mjs');

// preload.ts:
//   contextBridge.exposeInMainWorld('subcast', {
//     ...,
//     apiToken: process.env.SUBCAST_API_TOKEN,
//   });
```

```ts
// server/middleware/auth-desktop.ts（新增）
export default defineEventHandler((event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') return; // web 版跳过
  if (event.path === '/api/health') return;            // 健康检查放行
  const expect = process.env.SUBCAST_API_TOKEN;
  const got = getHeader(event, 'x-subcast-token');
  if (got !== expect) {
    throw createError({ statusCode: 401, statusMessage: 'BAD_TOKEN' });
  }
});
```

```ts
// app/plugins/desktop-fetch.client.ts（新增）
export default defineNuxtPlugin(() => {
  const api = (globalThis as any).subcast;
  if (!api?.apiToken) return;
  globalThis.$fetch = $fetch.create({
    headers: { 'x-subcast-token': api.apiToken },
  });
});
```

#### 端口策略

首选 `51301`，`EADDRINUSE` 时回退随机：

```ts
const PREFERRED_PORT = 51301;
server.listen(PREFERRED_PORT).on('error', (err) => {
  if (err.code === 'EADDRINUSE') server.listen(0); // 冲突自动随机
});
```

### 6.9 单实例锁（决策 20）

```ts
// desktop/main.ts
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});
```

### 6.10 启动恢复 — 僵尸任务（决策 21）

新增 Nitro plugin `server/plugins/02.recover-zombie-tasks.ts`：

```ts
export default defineNitroPlugin(() => {
  const db = getDb();
  // Transcribe: 已经有 chunk-level resume,直接重置为 queued 自动继续
  db.prepare(`UPDATE transcribe_tasks SET status='queued' WHERE status='running'`).run();
  // Translate / Insight: 无 fine-grained resume,标记为 failed 让用户主动重试
  db.prepare(`UPDATE translate_tasks SET status='failed', error_msg='Interrupted by app exit' WHERE status='running'`).run();
  db.prepare(`UPDATE insight_tasks SET status='error', error_msg='CANCELED' WHERE status='running'`).run();
});
```

主界面 / 队列页：对 Translate / Insight 的 `'failed'` 行显示 "上次未完成 - [重试] [忽略]" UI。

### 6.11 磁盘空间预检（决策 22）

```ts
// desktop/diskSpace.ts
import checkDiskSpace from 'check-disk-space';

export async function checkSpaceForModel(modelSizeBytes: number, targetPath: string) {
  const { free } = await checkDiskSpace(targetPath);
  const required = modelSizeBytes * 1.5;  // 50% buffer
  if (free < required) {
    return {
      ok: false,
      required,
      free,
      message: `需要 ${humanSize(required)},仅剩 ${humanSize(free)}`,
    };
  }
  return { ok: true };
}

export async function checkSpaceForVideo(durationSeconds: number, targetPath: string) {
  const { free } = await checkDiskSpace(targetPath);
  const estimateWav = Math.ceil(durationSeconds / 60) * 5_000_000; // 5MB/分钟
  if (free < 100_000_000) {
    return { ok: false, warning: true, /* 允许继续,但弹 warning */ };
  }
  return { ok: true };
}
```

- **模型下载前**：硬阻塞，UI 显示"需要 X MB / 仅剩 Y MB / 请清理磁盘"，禁用下载按钮
- **视频处理前**：警告 toast，允许用户继续

### 6.12 Nitro 启动失败 UX（决策 23）

```ts
// desktop/main.ts
try {
  await import('./.output/server/index.mjs');
} catch (err) {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Subcast 无法启动' /* i18n */,
    message: 'Subcast 无法启动' /* i18n */,
    detail: `可能原因：磁盘空间不足 / 权限问题 / 另一个 Subcast 实例占用。\n\n错误：${err.message}`,
    buttons: ['打开日志文件夹', '报告问题', '退出'] /* i18n */,
    defaultId: 2,
  });
  if (response === 0) shell.openPath(SUBCAST_PATHS.logs);
  if (response === 1) {
    const template = encodeURIComponent(
      `**Subcast 启动失败**\n版本：${app.getVersion()}\n平台：${process.platform}\n错误：${err.message}\n\n---\n[请粘贴最新日志]`
    );
    shell.openExternal(`https://github.com/twoer/subcast/issues/new?body=${template}`);
  }
  app.quit();
}
```

### 6.13 卸载行为（决策 24）

- **macOS**：拖 .app 到废纸篓只删 .app；`~/Library/Application Support/Subcast/` 留着
  - README 写清楚"如需彻底清理：拖 .app 到废纸篓后，再手动删除 `~/Library/Application Support/Subcast/`"
- **Windows NSIS**：卸载时弹窗 "是否同时删除您的视频缓存、字幕模型等数据？" **默认否**
  - 配置见 § 6.3 末尾

### 6.14 whisper.cpp 版本锁定（决策 25）

```yaml
# .github/workflows/build-whisper.yml
env:
  WHISPER_CPP_VERSION: v1.7.5  # 开工时确认 latest stable

jobs:
  build:
    steps:
      - run: git clone --depth 1 --branch ${{ env.WHISPER_CPP_VERSION }} https://github.com/ggerganov/whisper.cpp
      - run: cd whisper.cpp/build && cmake --build . --target whisper-cli
```

升级流程：改 `WHISPER_CPP_VERSION` → 跑回归 → 合并 PR → 下次 build 用新版。

### 6.15 应用菜单 + 托盘菜单（决策 29）

#### macOS App 菜单（系统级，自动显示在屏幕顶部）

```
Subcast
├── About Subcast           # 弹 About 对话框（决策 30）
├── Check for Updates...    # 决策 9 — manualUpdater
├── ─────────
├── Preferences...    ⌘,    # 跳 /settings 页
├── ─────────
├── Hide Subcast      ⌘H    # 系统标准
├── Hide Others       ⌥⌘H
├── ─────────
└── Quit Subcast      ⌘Q    # 真退出（先 cancelAll）
```

#### Help 菜单（macOS 顶部 + Windows 完全没有，全归托盘）

```
Help
├── Documentation              # GitHub README
├── Report Issue...            # GitHub Issues 模板
├── ─────────
└── Export Diagnostics...      # 打包近 7 天日志 zip
```

#### 系统托盘菜单（macOS 菜单栏 / Windows 通知区，两平台一致）

```
Show / Hide Window
─────────
Open Documentation
Report Issue...
Export Diagnostics...
─────────
Check for Updates...
─────────
Quit
```

#### 托盘图标

由 `public/favicon.svg` 渲染：
- macOS 菜单栏：22×22 template image（自动适配亮/暗）
- Windows 通知区：16×16 / 32×32 ICO

#### Windows 顶部菜单条：完全隐藏

```ts
import { Menu } from 'electron';
Menu.setApplicationMenu(null);
```

### 6.16 About 对话框（决策 30）

完整内容：

```
[Logo 128×128]

Subcast
免费 · 离线 · 大模型 — 音视频转写翻译

v0.1.0

─────────────────────────────────
100% 本地运行 · 零数据外发
─────────────────────────────────

使用以下开源组件：
· Whisper.cpp v1.7.x — MIT
· Ollama (外部) — MIT
· ffmpeg-static — LGPL
· Electron v37.x — MIT
· Nuxt 4 · Vue 3 — MIT

─────────────────────────────────

© 2026 twoer · Licensed under AGPL-3.0

[仓库] [License] [报告问题]
```

按钮行为：
- "仓库" → `shell.openExternal('https://github.com/twoer/subcast')`
- "License" → `shell.openExternal('https://github.com/twoer/subcast/blob/main/LICENSE')`
- "报告问题" → `shell.openExternal('https://github.com/twoer/subcast/issues/new')`

实现：可以是 Electron `dialog.showAboutPanel` 也可以是自定义 BrowserWindow。考虑到要按钮交互 + 渲染依赖列表，建议自定义窗口（一个 `/about` 路由）。

### 6.17 系统快捷键映射（决策 33）

| 快捷键 | macOS | Windows | 行为 |
|---|---|---|---|
| `⌘W` / `Alt+F4` | 关窗 | 关窗 | **隐藏到托盘**（决策 11） |
| `⌘Q` | 退出 | — | 真退出（先 `cancelAll`） |
| `Ctrl+Q` | — | 退出 | 真退出 |
| `⌘H` | 隐藏 app | — | macOS 系统标准 |
| `⌘M` | 最小化 | — | dock 化 |
| `⌘,` | 偏好 | — | 跳 /settings 页 |
| `⌃⌘F` / `F11` | 全屏 | 全屏 | 播放视频时有意义 |
| `⌘O` / `Ctrl+O` | — | — | **不绑定** — 拖放或主界面按钮 |

Player 内部快捷键（SPACE/K, J/L, 箭头, M/F/C/?/1-9, /, ⌘F）保持不变，与系统快捷键无冲突。

### 6.18 "首次需联网" 明示（决策 31）

#### README 顶部 callout（中英两份）

```markdown
> ⚠️ **首次配置需要联网**：完成 Whisper 模型 + Ollama + Qwen 模型下载后，
> 所有后续转写翻译完全本地，无任何数据外发。
```

#### Setup Wizard 顶部副标题

```
准备 Subcast
首次配置需要联网下载约 5GB 模型
```

### 6.19 i18n 新增 keys（决策 32）

桌面版新增 UI 需要在 `i18n/locales/{en,zh-CN}.json` 加 namespace `desktop.*`。完整 keys 清单（约 50 项）在 Phase 2 起草时同步给翻译，主要分类：

- `desktop.setupWizard.*` — Setup Wizard 标题/副标题/按钮/状态文案
- `desktop.modelManager.*` — 模型列表标签、下载进度、镜像切换
- `desktop.ollama.*` — Ollama 检测状态、引导按钮
- `desktop.trayMenu.*` — 托盘菜单各项
- `desktop.dialogs.*` — Check for Updates、startup failure、quit confirmation、disk space 等对话框
- `desktop.about.*` — About 对话框副标题、致谢、按钮
- `desktop.zombieRecovery.*` — "上次未完成的翻译/摘要 - [重试] [忽略]"
- `desktop.errors.*` — 桌面专用错误码（如 `OLLAMA_NOT_RUNNING`, `MODEL_NOT_DOWNLOADED`）

`README.zh.md` 是 `README.md` 的对应中文翻译。

---

## 七、实施路线图

基于决策 9 简化后估算，总计 **6-8 周**（团队首次做 Electron 加 1-2 周 buffer）。

### Phase 1：基础架构（**2-3 周**）

- [ ] 仓库根加 `LICENSE`（AGPL v3）+ `package.json` `"license": "AGPL-3.0-or-later"`
- [ ] 切 Nuxt 桌面构建为 SPA（`ssr: false`）
- [ ] 改造 `whisperPaths.ts` / `db.ts` 支持 `SUBCAST_DESKTOP` 环境变量
- [ ] 改造 `db.ts` 让 `SUBCAST_HOME` 从环境变量读取
- [ ] 写 `desktop/main.ts`：单实例锁 + Nitro in-process + 端口 51301 + 启动失败 dialog
- [ ] 写 `desktop/preload.ts`：注入 `window.subcast = { isDesktop, apiToken, platform, appVersion }`
- [ ] 写 `app/plugins/desktop-fetch.client.ts`：自动附 token header
- [ ] 写 `server/middleware/auth-desktop.ts`：token 校验
- [ ] 配置 electron-builder：`extraResources` 接 whisper-cli + ffmpeg + icon.icns/ico
- [ ] 配置 electron-rebuild，跑通 better-sqlite3
- [ ] icon 生成脚本：`favicon.svg` → `icon.icns` (16/32/128/256/512/1024) + `icon.ico` (16/32/64/128/256)
- [ ] 强制暗色：主进程注入 `<html class="dark">`
- [ ] 文件关联（决策 12）：electron-builder `fileAssociations`
- [ ] CI 矩阵 `[macos-14 (arm64), windows-latest (x64)]` 跑通 build
- [ ] **里程碑**：
  - 双平台能打出 .dmg / .exe，启动后 `/api/health` 返回 200
  - electron-rebuild 不抛 NODE_MODULE_VERSION 错误
  - About 对话框能弹（基本占位即可）

### Phase 2：首次运行向导（**1-2 周**）

- [ ] 写 `desktop/modelManager/`：下载器 + Range 续传 + SHA256 校验
- [ ] HF 镜像切换 UI（决策 27）
- [ ] 磁盘空间预检 `desktop/diskSpace.ts`（决策 22）
- [ ] `/setup-check` 路由（检测各项依赖；决策 36 = 不探测旧 `~/.subcast/`）
- [ ] `/setup-wizard` 三步：Whisper 选择/下载、Ollama 检测/引导、Qwen 选择/拉取
- [ ] 下载进度组件：百分比 + 字节 + 估算剩余时间（决策 28）
- [ ] 部分并行流程实现（Step 1 后台下 + Step 2 同时进行）
- [ ] Ollama `/api/pull` NDJSON 进度解析
- [ ] Whisper 模型扫描复用流程（决策 34）：`whisperScan.ts` 扫描常见路径 + 软链接/复制/忽略 UI
- [ ] Qwen 已装模型检测（决策 35）：`/api/tags` 列已装的，UI 标 ✓ + 默认选已装
- [ ] **里程碑**：全新机器（无任何模型）能跑完向导到主界面

### Phase 3：桌面增强 + 启动恢复（**1 周**）

- [ ] 系统托盘 `desktop/trayMenu.ts`（决策 11 + 29）
- [ ] 关闭窗口隐藏到托盘 + Cmd+Q/Ctrl+Q 真退出区分
- [ ] `window-state` 持久化（决策 14）
- [ ] 启动恢复 plugin `server/plugins/02.recover-zombie-tasks.ts`（决策 21）
- [ ] 主界面 / 队列页对 failed translate / insight 显示 "重试 / 忽略" UI
- [ ] `queue.cancelAll()`、`insightTasks.abortAll()` 实现
- [ ] 拖放文件接 preload IPC
- [ ] About 对话框完整内容（决策 30）
- [ ] Export Diagnostics 实现（打包近 7 天日志 zip）
- [ ] 完整菜单结构（决策 29）：macOS App + Help 菜单；Windows 顶部菜单条隐藏

### Phase 4：签名 + 更新策略（**1 周**）

- [ ] Windows self-signed 证书生成 + CI Secrets
- [ ] electron-builder `mac.identity = null` + `win.certificateFile` 配置
- [ ] NSIS 自定义脚本：卸载弹窗 "是否同时删除数据"（决策 24）
- [ ] Windows electron-updater + GitHub Releases publisher + blockmap 差分
- [ ] macOS `desktop/manualUpdater.ts` + Help 菜单 + 托盘菜单 "Check for Updates"
- [ ] 启动后 5 秒静默触发一次手动更新检查
- [ ] **里程碑**：
  - Win：双击 .exe → SmartScreen → "More info" → "Run anyway" 能装；v0.1.0 → v0.1.1 自动差分更新
  - macOS：双击 .dmg → 拖入 Applications → 右键打开能跑（14 及更早）/ 隐私设置仍要打开（15+）；Check for Updates 能弹出新版提示并打开下载页

### Phase 5：i18n + 测试 + 发布（**1.5 周**）

- [ ] i18n 完整覆盖（决策 32）：`desktop.*` namespace 约 50 个新 keys
- [ ] README.md（英文）+ README.zh.md（中文）
- [ ] 首装步骤截图：macOS 14 / macOS 15+ / Windows 三套（决策 9 后果）
- [ ] 双平台烟雾测试（macOS arm64 / Win x64）
- [ ] 卸载残留检查（macOS / Windows 两种数据保留行为）
- [ ] Whisper 扫描复用测试（在 dev 机制造 ~/.subcast/.../models/ 场景，验证软链接/复制/忽略三路径）
- [ ] Qwen 已装检测测试（dev 机 `ollama pull qwen2.5:14b` 后跑向导，验证标 ✓ + 默认选）
- [ ] 模型下载失败恢复测试（断网 → 继续 → 校验失败 → 重试）
- [ ] 磁盘空间不足测试（下载前预检 + 视频处理 warning）
- [ ] 多实例锁测试（双击两次只起一个窗口）
- [ ] 应用内 Help 页面 + 嵌入步骤截图
- [ ] 发 v0.1.0 到 GitHub Releases

---

## 八、风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| better-sqlite3 在某平台 rebuild 失败 | 高 | CI 矩阵覆盖；保留 prebuild fallback |
| macOS 用户被 Gatekeeper 警告吓退（决策 9）| **高** | README + 应用内 Help 两套截图（14 / 15+）；首发版考虑站内说明置顶 |
| macOS 自动更新失效（决策 9）| 中 | 菜单 `Help → Check for Updates` + 启动 5s 静默检查；新版到下载页只 2 次点击 |
| Windows SmartScreen 警告（决策 9）| 中 | self-signed 略好（能看签名链）；README 截图引导；后期可升 OV |
| Windows self-signed 证书 5 年到期 | 中 | 续期文档；过期前 6 个月预警；续期后 SmartScreen reputation 清零 |
| Whisper / Ollama 模型下载失败 | 中 | 断点续传 + SHA256 + 重试；HF 镜像切换；进度持久化 |
| 国内 Hugging Face 访问慢/失败 | 中 | hf-mirror.com 一键切换（决策 27） |
| 用户没装 Ollama 又不愿装 | 中 | 翻译/摘要功能屏蔽，转录功能仍可用；UI 明确提示 |
| Electron 安全漏洞 | 中 | contextIsolation + sandbox + `nodeIntegration: false` + token 鉴权 |
| Windows 自动更新失败 | 中 | 全量包永远可作 fallback；blockmap + differential.json 校验 |
| Whisper 模型扫描的软链接被用户删除原文件 | 低 | 扫描复用 UI 默认勾选"软链接"但旁边显示警告 "原文件移动/删除会让 Subcast 失效"；用户可选"复制"防范 |
| ffmpeg 许可证升级 | 低 | 锁定 ffmpeg-static 版本 |
| whisper.cpp 版本漂移导致模型不兼容 | 低 | 决策 25：固定 tag，升级走 review |
| 磁盘空间用尽 | 低 | 决策 22：模型下载硬阻塞 + 视频处理 warning |

---

## 九、package.json 新增脚本

```jsonc
{
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build",
    "preview": "nuxt preview",

    // 桌面端
    "build:web": "nuxt build",
    "build:desktop:assets": "NUXT_SSR=false nuxt build",
    "build:desktop:native": "electron-rebuild -f -w better-sqlite3",
    "build:desktop:icons": "node scripts/generate-icons.mjs",  // SVG → icns + ico
    "build:desktop": "pnpm build:desktop:icons && pnpm build:desktop:assets && pnpm build:desktop:native && electron-builder",
    "build:desktop:mac": "pnpm build:desktop:icons && pnpm build:desktop:assets && pnpm build:desktop:native && electron-builder --mac",
    "build:desktop:win": "pnpm build:desktop:icons && pnpm build:desktop:assets && pnpm build:desktop:native && electron-builder --win",
    "dev:desktop": "pnpm build:desktop:assets && electron desktop/main.ts"
  }
}
```

---

## 十、与现有代码的兼容性

| 文件 | 改动 |
|------|------|
| `server/utils/whisperPaths.ts` | 加 `IS_DESKTOP` 分支 |
| `server/utils/db.ts` | `SUBCAST_HOME` 从 env 读，桌面版主进程注入 |
| `server/utils/queue.ts` | 加 `transcribeQueue.cancelAll()` / `translateQueue.cancelAll()` |
| `server/utils/insightTasks.ts` | 加 `abortAllInsightTasks()` |
| `server/middleware/auth-desktop.ts` | **新增**，token 校验 |
| `server/plugins/02.recover-zombie-tasks.ts` | **新增**，启动时处理僵尸任务 |
| `app/composables/useDesktop.ts` | **新增**，读 `window.subcast` |
| `app/plugins/desktop-fetch.client.ts` | **新增**，token header 注入 |
| `app/pages/setup-check.vue` | **新增** |
| `app/pages/setup-wizard.vue` | **新增** |
| `app/pages/about.vue` | **新增**（About 对话框走自定义窗口） |
| `nuxt.config.ts` | 桌面构建分支 |
| `package.json` | `"license": "AGPL-3.0-or-later"` |
| `LICENSE` | **新增**，AGPL v3 全文 |
| `README.md` / `README.zh.md` | 重写，加 callout 和首装步骤截图 |
| `i18n/locales/en.json` / `zh-CN.json` | 加 `desktop.*` namespace 约 50 keys |

**不需要动**：所有现有 composable / 组件 / API 端点 / DB schema 迁移。

---

## 十一、年度成本汇总

依据决策 9，桌面 app 发布的运营成本：

| 项 | 必要性 | 单价/年 | 备注 |
|---|---|---|---|
| Apple Developer Program | ❌ 不要 | $99 | 决策 9 = 不签 macOS |
| Windows OV 代码签名证书 | ❌ 不要 | ~$200 | 决策 9 = self-signed |
| Windows EV 代码签名证书 | ❌ 不要 | ~$400 | 决策 9 = self-signed |
| GitHub Releases | 免费 | $0 | 公开仓库免费 |
| GitHub Actions CI | 免费 | $0 | 公开仓库免费；私有仓 macOS-arm64 runner 10× 单价 |
| 国内 OSS / CDN（决策 6 后期）| 可选 | ~$10-30/月 | 阿里 OSS / 七牛云，按流量计费 |
| Sentry / 监控（决策 8 不要）| ❌ 不要 | $0 | 纯本地日志 |
| **首年总计** | | **$0** | 不算后期 CDN |
| **每年持续** | | **$0** | 同上 |

后期可能升级（不影响首发）：
- Windows OV 证书（消除部分 SmartScreen 警告）：+$200/年
- Apple Developer Program（签 + 公证 → 自动更新恢复）：+$99/年

---

## 十二、国内镜像策略（决策 6 后期）

第一阶段：仅 GitHub Releases。
第二阶段（稳定后）：

| 资源 | 主源 | 国内镜像 | 触发条件 |
|------|------|---------|---------|
| 安装包（.dmg / .exe）| GitHub Releases | 阿里 OSS / 七牛云（CDN） | 用户在 UI 内可选切换；自动 race 5 秒选最快 |
| Whisper 模型 | Hugging Face | hf-mirror.com | 已实现（决策 27） |
| Qwen 模型 | Ollama Registry | Ollama 自己处理 | 不归我们管 |
| Ollama 安装包 | ollama.com | 无 | 国内访问 ollama.com 通常 OK |

什么算"稳定"：第一个 minor 版本（如 v0.2.0）+ 50 个 GitHub stars + 用户反馈渠道稳定。

---

## Changelog

### v5 (2026-05-12)

- **§ 〇 决策表 + 3 项**（33 → 36）：新增 § 0.7 数据管理与复用（Q34 Whisper 扫描复用 / Q35 Qwen 已装检测 / Q36 不迁移 web 版数据）
- **§ 1.3 简化**：删除 "迁移策略" 段；明确"桌面 app 不导入 web 版数据"
- **§ 5.1 流程**：setup-check 去掉"旧 ~/.subcast/ 探测"
- **§ 5.4 重写**：加入 Qwen 已装检测 UI 草图 + `listInstalledOllamaModels()` 实现
- **§ 5.7 新增**：Whisper 模型扫描复用详细流程（扫描路径、UI 草图、软链接/复制/忽略三路径实现）
- **§ 七 Phase 1-5 任务清单更新**：去除所有"~/.subcast/ 导入"任务；新增 Whisper 扫描复用 + Qwen 已装检测的任务和测试
- **§ 八 风险表**：删除"老 ~/.subcast/ 数据丢失"；新增"软链接被用户删除原文件"

### v4 (2026-05-12)

- **§ 〇 决策表扩展**：9 → **33 项**，按主题分组（核心技术 / 产品命名 / UX / 启动恢复 / 构建下载 / 菜单一致性）
- **修正 v3 内部 6 处歧义**：
  - 端口策略：§ 2.1 / § 〇 决策 4 / § 6.8 三处统一为 "51301 首选 + 冲突回退随机"
  - CI 矩阵：§ 2.3 / § 4.1 / § 7 删除 macOS x64 + win32-arm64，仅保留 macOS arm64 + Win x64
  - macOS updater：§ 三架构图 + § 4.3 差异表更新为 "Win: electron-updater / macOS: manualUpdater"
  - Ollama 用词：§ 4.3 改"启停"为"只检测，不 spawn"
  - § 6.2 macOS 首装步骤拆为 14 及更早 / 15+ 两条路径
  - Export Diagnostics 位置：Help 菜单 + 托盘菜单两处都接
- **新增 § 5.6 下载流程**：部分并行 + HF 镜像切换 + 进度估算（决策 26-28）
- **新增 § 6.9-6.19 共 11 个技术细节小节**：单实例锁 / 僵尸任务恢复 / 磁盘预检 / Nitro 启动失败 / 卸载行为 / whisper.cpp 版本锁 / 菜单结构 / About 对话框 / 快捷键映射 / 首次联网明示 / i18n keys 范围
- **§ 七 路线图重写**：Phase 1-5 任务清单根据 33 项决策展开；新增 icon 生成、单实例锁、托盘菜单等任务
- **§ 八 风险表扩展**：新增 self-signed 证书 5 年到期、国内 HF 访问、whisper 版本漂移、磁盘用尽四条
- **§ 十 兼容性表扩展**：新增 setup-check.vue / setup-wizard.vue / about.vue / desktop-fetch plugin / auth middleware / recover-zombie plugin 等改动项
- **新增 § 十二 国内镜像策略**：明确"稳定后"的定义和分资源镜像方案

### v3 (2026-05-12)

- **新增 §〇 设计决策（已定）**：9 项关键决策固化
- **§ 5.2 模型列表更新**：`large-v3` → `large-v3-turbo`
- **§ 6.2/6.3 签名段重写**：从"完整公证流程"改为"不签名 + 用户引导"路线
- **§ 6.4 自动更新重写**：分平台 — Windows 走 electron-updater 差分；macOS 改"Check for Updates"手动检查
- **§ 6.8 新增**：本地 API 鉴权 + 端口策略
- **§ 七 Phase 4 大幅简化**：去除 Apple 公证流程
- **§ 八 风险表更新**：新增 Gatekeeper / 自动更新失效 / SmartScreen 三条"决策 9 直接后果"
- **§ 十一 新增**：年度成本汇总（首年 **$0**）
- **App ID**：固定为 `io.github.twoer.subcast`

### v2 (2026-05-12)

- **新增 Phase 0**：在写代码前必须定 4 个关键决策
- **修正运行时检测代码**：v1 用了 `import.meta.env` 错误，v2 改为 preload 注入
- **明确 Ollama 不 bundle**
- **whisper-cli 二进制来源细化**：CI 矩阵 + Metal/CPU 决策
- **better-sqlite3 ABI 注释更准确**
- **新增 ffmpeg 许可证讨论**
- **新增数据迁移章节**
- **新增 electron-updater 差分更新**
- **新增 SSE / 拖放 / 子进程清理**等技术细节
- **时间估算修正**：3-4 周 → 7-9 周
