# Subcast

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/twoer/subcast)](https://github.com/twoer/subcast/releases)

> 免费 · 离线 · 大模型 — 音视频转写翻译
>
> English: [README.en.md](./README.en.md)

> ⚠️ **首次配置需要联网**：完成 Whisper 模型 + Ollama 安装 + Qwen 模型下载后，所有后续转写翻译完全本地，**不联网、不调用付费 API、不上报任何遥测**，所有数据都留在本机。

把视频拖进来 → 本地 Whisper 转写 → 边播放边按需翻译。Subcast 是面向 macOS / Windows 的桌面应用。同一套 Nuxt/Nitro 代码也用于 `pnpm dev` 本地开发——这只是无需重打包 Electron 时迭代 UI 的最快方式，**不是**一个可部署/对外提供服务的 Web 产品。

## 预览

**首页** —— 拖入视频，下方实时显示转写 / 翻译队列。

![首页](demo/index.png)

**播放器** —— 左边视频（自定义控件），右边按语言切换的字幕列表，已缓存语言在下拉里打 ✓ 标记，跟随播放进度高亮当前 cue。

![播放器](demo/player.png)

**设置** —— 硬件信息 + 模型选择 + 缓存管理 + 字幕显示偏好。

![设置](demo/setting.png)

## 为什么用它

云端转写服务用便利换取你的媒体——每次上传都把敏感音视频（访谈、会议、语音备忘）暴露给第三方、受限于它支持的语言、按小时计费。Subcast 面向无法接受这种妥协的人：律师、记者、研究者，以及任何受保密或数据驻留约束的用户，还有更愿意把整套流程留在本机的本地大模型爱好者。转写、翻译、AI 摘要全部在单个应用里本地完成，**一次性下载模型后零持续成本、数据不离开你的机器**。

> **当前状态：** 早期阶段（0.x）。1.0 之前，打包方式、配置布局、部分 API 可能在小版本间变动。本项目由单人维护，PR review / 合并的响应周期约为 1–2 周。欢迎提交 bug 报告和修复；较大的新功能建议先开 issue 讨论。

## 亮点

- 🔒 **隐私优先** —— 所有数据与推理都在本地完成
- 💸 **零成本** —— 不依赖任何云端 API
- 🌍 **多语言** —— 原文 + 任意目标语言，可实时切换
- ⚡ **流式体验** —— 转写过程中即可开始观看
- ↩️ **断点续传** —— 中途强行结束进程，下次会从最后一个已完成的 30s 分片继续
- 🚦 **自适应** —— 首次启动按硬件等级自动推荐 Whisper / Ollama 模型，并复用本机已有模型
- 📥 **导出 & 搜索** —— 单语 / 多语 / 双语字幕导出（VTT / SRT / TXT，多语自动 ZIP）；播放器内常驻搜索框，`/` 或 `Ctrl/Cmd+F` 聚焦输入，匹配高亮 + `Enter` / `Shift+Enter` 循环
- ✨ **AI 总结 + 章节** —— 播放器内一键生成；本地 Ollama 流式输出；章节可点击跳转

---

## 桌面版安装

<!-- TODO: 此处插入 Setup Wizard Step 1 截图。 -->

### 下载

从 [Releases 页面](https://github.com/twoer/subcast/releases) 下载最新安装包：

| 平台 | 文件 | 体积约 |
|---|---|---|
| macOS（Apple Silicon） | `Subcast-<version>-arm64.dmg` | 260 MB |
| Windows（x64） | `Subcast-Setup-<version>.exe` | 240 MB |

Whisper / Ollama / Qwen 模型本身由首次运行向导按需下载，不打包进安装器。推荐档（`base` + `qwen2.5:7b`）额外占用约 **5 GB**。

### macOS

1. 双击 `.dmg`，把 **Subcast** 拖入 Applications。
2. 首次启动会出现 Gatekeeper 警告（Subcast 故意不签名，见下方"License & 成本"）。处理一次即可：

   - **macOS 14（Sonoma）及更早** —— 在 Applications 里**右键** `Subcast.app` → **打开** → 确认。
   - **macOS 15+（Sequoia）** —— 系统设置 → **隐私与安全性** → 下拉至 *"Subcast 已被阻止"* → **仍要打开**，再输入密码授权。

   <!-- TODO: 并排两张截图，新旧系统各一张。 -->

3. 跟随首次运行向导：
   1. **Whisper 转录模型** —— 选档位（默认 `base`）。如果本机已有 `ggml-*.bin` 文件（如来自 [whisper.cpp](https://github.com/ggerganov/whisper.cpp) 或 [Aiko](https://sindresorhus.com/aiko)），Subcast 会提示软链接 / 复制，避免重复下载。
   2. **Ollama 运行时** —— 安装到独立目录，作为菜单栏程序常驻。Subcast 自动检测；如果未运行，点击"前往 ollama.com"，安装好后回到向导点"我已安装"重检即可。
   3. **Qwen 语言模型** —— 在 `3b` / `7b`（推荐）/ `14b` 中选择；本机已有的型号会自动标 ✓ 并优先选中。

4. 完成。把视频拖入主窗口，或者在 Finder 里右键 `.mp4`/`.mkv`/`.mov`/`.webm`/`.mp3`/`.wav`/`.m4a` → "打开方式 → Subcast"。

### Windows

1. 双击运行 `Subcast-Setup-<version>.exe`。SmartScreen 会提示 *"Windows protected your PC"* —— Subcast 使用自签名证书（见下方"License & 成本"）。

   - 点击 **More info** → 确认发布者为 **Subcast (twoer)** → **Run anyway**。

   <!-- TODO: SmartScreen 警告截图。 -->

2. 选择安装位置（默认按用户安装，`%LOCALAPPDATA%\Programs\Subcast`）。
3. 跟随与 macOS 完全一致的三步设置向导。
4. 安装器会把 **Subcast** 加入开始菜单，并可选地为上述媒体后缀注册"打开方式"项。

用户数据存放位置：Windows 下 `%APPDATA%\Subcast`，macOS 下 `~/Library/Application Support/Subcast`。模型、缓存字幕、日志都在这里 —— Subcast 不会写出其数据目录之外的任何位置。

---

## 日常使用

### 托盘 / 菜单栏图标

关闭主窗口只会**隐藏到托盘**，后台任务（转录、翻译、AI 摘要）继续跑。托盘菜单可以重新打开窗口、运行"导出诊断"、"检查更新"、退出。

`Cmd+Q` / `Ctrl+Q`（或托盘里的"退出"）才是真正的退出：所有正在运行的任务会被干净地取消并写入数据库，下次启动自动从最后一个分片继续。

### 播放器键盘快捷键

| 按键 | 操作 |
|---|---|
| Space / K | 播放 / 暂停 |
| ← / → | 后退 / 前进 5 秒 |
| J / L | 后退 / 前进 10 秒（YouTube 风格） |
| ↑ / ↓ | 音量 ±10% |
| < / > | 倍速调一档 |
| M / F / C | 静音 / 全屏 / 字幕开关 |
| 1-9 | 跳到视频 10%–90% 进度 |
| ? | 打开快捷键帮助 |
| Esc | 关闭任意对话框 |

---

## 排查

### 导出诊断

遇到问题时：**Help → Export Diagnostics…**（托盘菜单里也有）会把近 7 天的结构化日志 + 一份 `system.json`（OS、应用版本、硬件信息）打包成 zip。**不包含**任何视频、字幕文本、文件名 —— 提交 issue 时附上即可。

### 常见问题

| 现象 | 解决办法 |
|---|---|
| 向导显示"未检测到 Ollama"，但你已安装 | Ollama 是独立的菜单栏 / 任务栏程序。打开它的图标确认"正在运行"，回到向导点"我已安装"重检即可。 |
| Whisper 模型下载卡在 0% | 中国大陆用户：在向导里勾选"使用 hf-mirror.com"。已经下载的字节会在镜像上继续 —— 无需重头开始。 |
| macOS 15+ 上 Cmd-点击应用没反应 | 打开"系统设置 → 隐私与安全性"，在页面底部会有专门的"仍要打开"按钮（这个系统版本起，原先的"打开方式"菜单不再适用）。 |
| 转录到一半 Subcast 进程没了 | 直接重启。转录任务会从最后一个 30s 分片继续；翻译任务会被标记为"上次未完成"，主页给出"重试 / 忽略"按钮 —— 不会偷偷重新调用 Ollama 浪费 token。 |

---

## 自动更新

- **Windows** —— Subcast 在后台从 GitHub Releases 拉取差分包，下次启动时自动应用。差分包使用与安装器同一份自签名证书。
- **macOS** —— 手动：**Help → Check for Updates…**（启动后 5 秒也会静默检查一次，仅在"有新版本"时弹窗）。点击会在系统浏览器打开发布页，自行下载并替换 Applications 里的 .app。

---

## 开发者：从源码运行

桌面版底层就是 Nuxt 4 + Nitro，Web 模式直接 `pnpm dev` 就能在浏览器里跑。

### 前置依赖

| 依赖 | 用途 |
|---|---|
| Node.js 22+ | Nuxt 4 / Nitro 2 运行时 |
| pnpm 9+ | 包管理器 |
| ffmpeg + ffprobe | 提取音轨、读取时长 |
| cmake + C++ 工具链 | 首次构建 `whisper-cli` 二进制（仅源码模式需要） |
| 本地 Ollama 服务 | 默认监听 `http://localhost:11434` |

**模型 / 磁盘空间**：

| 配置档 | Whisper（转写） | Ollama（翻译） | 模型总占用 |
|---|---|---|---|
| **最小可跑** | `tiny` ≈ 78 MB | `qwen2.5:0.5b` ≈ 400 MB | **≈ 480 MB** |
| **推荐** | `base` ≈ 142 MB | `qwen2.5:7b` ≈ 4.7 GB | **≈ 5 GB** |
| 高精度 | `large-v3` ≈ 2.9 GB | `qwen2.5:14b` ≈ 9 GB | ≈ 12 GB |

**硬件加速**：whisper.cpp 在 Apple Silicon 上自动用 Metal、在 NVIDIA 上自动用 CUDA；Ollama 同理。无需额外配置。

### 安装依赖（仅源码模式）

#### macOS

```bash
brew install node pnpm ffmpeg cmake ollama
ollama serve
ollama pull qwen2.5:7b
```

#### Windows

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg Kitware.CMake Ollama.Ollama
npm install -g pnpm
ollama serve
ollama pull qwen2.5:7b
```

C++ 工具链：装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选"使用 C++ 的桌面开发"工作负载。

#### Linux

```bash
sudo apt install ffmpeg cmake build-essential
curl -fsSL https://ollama.com/install.sh | sh && ollama serve &
ollama pull qwen2.5:7b
```

### 跑起来

```bash
git clone https://github.com/twoer/subcast.git
cd subcast
pnpm install      # 首次较慢，会编译 better-sqlite3 等原生模块

# 编译 whisper-cli（仅源码模式）
cd node_modules/nodejs-whisper/cpp/whisper.cpp
cmake -B build
cmake --build build --target whisper-cli -j
cd -

# 下载 Whisper 模型
npx --no-install nodejs-whisper download

# 启动
pnpm dev          # http://localhost:3000
```

桌面构建：

```bash
pnpm build:desktop          # 当前平台
pnpm build:desktop:mac      # macOS arm64
pnpm build:desktop:win      # Windows x64
```

测试 / 类型检查：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

### 设计文档

- [`docs/desktop-packaging.md`](./docs/desktop-packaging.md) —— 桌面架构 + 约 36 项设计决策
- [`docs/desktop-execution-plan.md`](./docs/desktop-execution-plan.md) —— Phase 0 到 Phase 5 的 file-by-file 执行计划
- [`docs/windows-codesigning.md`](./docs/windows-codesigning.md) —— Windows 自签名证书 runbook

---

## 贡献

欢迎提交 bug 报告、修复、文档与翻译。贡献指南见
[`CONTRIBUTING.md`](./CONTRIBUTING.md)（英文），其中包含开发环境、模块
边界、Pull Request 流程，以及一份适合首次贡献的
[good first issue 清单](./CONTRIBUTING.md#good-first-issues)。

本项目遵循 [Contributor Covenant 行为准则](./CODE_OF_CONDUCT.md)。
如发现安全漏洞，请按 [`SECURITY.md`](./SECURITY.md) 私下报告 ——
**不要**开公开 issue。

---

## License & 成本

[Apache-2.0](./LICENSE) © 2026 twoer

Subcast 采用 Apache 2.0 开源协议：允许自由使用、修改、分发（包括商业用途），需保留版权与许可声明；衍生作品可选择是否开源。

第三方组件（whisper-cli MIT、ffmpeg LGPL build、所有 npm 依赖）的归属
与来源声明见 [`NOTICES.md`](./NOTICES.md)。LGPL 版 ffmpeg 对应源码可从
<https://ffmpeg.org/download.html> 获取。

按照设计，**维护者发布 Subcast 每年成本是 $0**：

- macOS：不加入 Apple Developer Program（$99/年）。用户首次启动会看到 Gatekeeper 警告，按上述步骤点一次即可。
- Windows：自签名代码证书（$0）。用户首次安装会看到 SmartScreen 警告，按上述步骤 *"More info → Run anyway"* 即可。
- 分发：GitHub Releases（公开仓库免费）。
- 遥测 / 崩溃上报：**无**。诊断只在用户主动导出时打包。

如果要消除首次警告，需要升级到 Apple Developer 账号 + Windows OV 证书（合计 \~$300/年），不在 v0.1.0 路线图上。
