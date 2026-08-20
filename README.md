# Subcast

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/twoer/subcast)](https://github.com/twoer/subcast/releases)
[![macOS](https://img.shields.io/badge/platform-macOS%20%28Apple%20Silicon%29-black?logo=apple&logoColor=white)](https://github.com/twoer/subcast/releases/latest)

> 免费 · 离线 · 大模型 —— 音视频转写 / 翻译 / AI 摘要桌面应用
>
> English: [README.en.md](./README.en.md) &nbsp;·&nbsp; 文档站：**https://twoer.github.io/subcast**

📥 **[下载最新版 →](https://github.com/twoer/subcast/releases/latest)**（macOS Apple Silicon，约 400 MB）

**开箱即用**：安装包内置 SenseVoice 转写模型，装完拖入视频即可转写，无需联网。翻译与 AI 摘要由内置的本地 Qwen3 驱动，首次使用时在应用内下载一次模型；此后**所有功能完全离线**——不联网、不调云端 API、不上报遥测，数据不离开你的电脑。

![播放器](demo/player.png)

## 它能做什么

把视频或音频拖进来，剩下的都在本机完成：

- 🎙 **双引擎转写** —— SenseVoice（内置，中/英/日/韩/粤，CPU 上约快 15 倍）+ 按需下载的 Whisper（99 语言、词级时间戳）；`auto` 模式按音频语言自动分发
- ✨ **AI 转写润色** —— 本地 Qwen3 自动修正错别字、统一中英文写法（a i → AI）、补全标点；原文保留，播放器一键切换「原文 / 润色」
- 🌍 **多语言翻译** —— 本地 Qwen3 翻译成任意目标语言，播放器内实时切换；单语 / 双语 / 多语字幕导出（VTT / SRT / TXT）
- 📝 **AI 摘要 + 章节** —— 一键流式生成摘要与可点击跳转的章节标记
- ⚡ **流式 + 批处理** —— 转写进行中即可开始观看；多文件批处理会先完成整批转写和关键字幕结果，再继续增强任务
- 🗣 **说话人识别** —— 自动区分说话人，可重命名、可调整人数重跑
- 🔗 **URL 导入** —— 粘贴 B 站 / YouTube 等 1500+ 站点链接自动下载转写（仅限你有权下载的内容，见 [免责声明](./DISCLAIMER.md)）
- 🔒 **隐私优先** —— 无账号、无遥测、无订阅；设置页可查看转写模型与 AI 模型何时运行、加载或自动释放

## 快速上手（macOS）

1. 下载 `.dmg`，把 **Subcast** 拖入 Applications
2. 首次打开提示「已损坏」？这不是真的损坏，是 Gatekeeper 对未签名应用的拦截。终端执行一次即可：

   ```bash
   xattr -cr /Applications/Subcast.app
   ```

3. 跟随首次设置向导（转写引擎已内置；AI 功能按提示下载 Qwen3 模型，8 GB 内存机器推荐 4B 档）
4. 把视频拖进窗口，开始转写

> 📌 **Windows**：本版本暂缓 Windows 构建，将在后续版本回归。
>
> 📖 完整安装指南、使用教程、模型选择与常见问题见**[文档站](https://twoer.github.io/subcast)**。

## 常见问题

| 现象 | 解决 |
|---|---|
| macOS 提示「已损坏」 | 终端执行 `xattr -cr /Applications/Subcast.app`（只需一次） |
| 模型下载慢 / 卡住 | 设置向导或模型页勾选 **hf-mirror.com** 镜像；已下载的字节会续传，无需重头开始 |
| 英文视频识别质量一般 | 下载 Whisper 模型（推荐 large-v3-turbo）后重新转写；`auto` 引擎会让英文自动走 Whisper |
| 遇到 bug | Help → 导出诊断（不含媒体内容与字幕文本），附到 [issue](https://github.com/twoer/subcast/issues) |

## 从源码运行

```bash
pnpm install
pnpm dev:desktop:hot   # 桌面开发模式（热重载）
pnpm dev               # 浏览器开发模式
pnpm test              # 测试
```

前置依赖与桌面打包细节见 [CONTRIBUTING.md](./CONTRIBUTING.md)、[AGENTS.md](./AGENTS.md) 与 [`docs/`](./docs/)；打包命令：`pnpm build:desktop:mac`。

## 给 AI 助手使用

仓库包含两种面向 AI 助手的本机集成：Codex skill 用于工作流指引；MCP Server 可让 Codex、Claude Desktop 等客户端直接调用 Subcast 工具。先打开 Subcast，在「设置 → AI 助手」中启用本机访问。访问授权仅在本次应用运行期间有效，且不会要求你在聊天中粘贴桌面会话 token。

安装 Codex skill：

```bash
pnpm skill:install
```

它会安装到 `~/.codex/skills/subcast`；已安装旧版本时显式执行 `pnpm skill:install -- --force`。

安装版优先使用 MCP。在客户端配置中加入：

```json
{
  "mcpServers": {
    "subcast": {
      "command": "/Applications/Subcast.app/Contents/Resources/subcast-mcp"
    }
  }
}
```

从源码开发时可改用：

```json
{
  "mcpServers": {
    "subcast": {
      "command": "node",
      "args": ["/absolute/path/to/subcast/desktop-dist/subcastMcp.js"]
    }
  }
}
```

源码方式先执行一次 `pnpm build:desktop:main` 生成入口。安装版启动器会随 v0.5.3 桌面发行包提供。完整说明见官网指南：[AI 助手](https://twoer.github.io/subcast/guide/ai-assistant)。

## License

[Apache-2.0](./LICENSE) © 2026 twoer —— 完全免费，可自由使用、修改、分发（含商业用途）。第三方组件声明见 [NOTICES.md](./NOTICES.md)。

> 应用未购买签名证书（年成本 $0 是项目可持续的前提），首次安装的 Gatekeeper 警告属预期，点一次「仍要打开」即可。
