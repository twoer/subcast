---
description: 在 Subcast 中启用本机 AI 助手访问，配置 MCP，并让 Codex 等 agent 在本机导入、转写、分析与导出媒体包。
---

# AI 助手

Subcast 可以给本机 AI 助手提供一个受控入口。启用后，Codex、Claude Desktop 等支持 MCP 的客户端可以通过本机通道调用 Subcast：导入媒体、查看处理状态、启动转写或 AI Insights，并导出带时间戳证据的媒体包。

这个入口默认关闭。每次打开 Subcast 后都需要你显式启用，退出应用后授权失效。

## 1. 启用本机访问

打开 Subcast，进入「设置 → AI 助手」，点击「启用本机 AI 助手访问」。

启用后，Subcast 会在本机应用数据目录写入一个临时访问配置，只允许当前用户读取。不要把桌面会话 token 或配置内容粘贴到聊天里；支持的 agent 应该通过 MCP 或 Subcast skill 自动读取授权配置。

## 2. 安装 Codex skill

在仓库源码目录执行：

```bash
pnpm skill:install
```

它会把 Subcast skill 安装到 `~/.codex/skills/subcast`。如果已经安装过旧版本，需要明确使用：

```bash
pnpm skill:install -- --force
```

之后可以让 Codex 执行类似任务：

```text
使用 Subcast 转写 /path/to/video.mp4
使用 Subcast 导出这个视频的媒体包
```

## 3. 配置 MCP

安装版优先使用随包提供的 MCP 启动器：

```json
{
  "mcpServers": {
    "subcast": {
      "command": "/Applications/Subcast.app/Contents/Resources/subcast-mcp"
    }
  }
}
```

源码开发时先构建桌面入口：

```bash
pnpm build:desktop:main
```

然后在客户端中指向源码入口：

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

## 4. 媒体包里有什么

Subcast 的基础归档包会导出：

- `manifest.json`：脱敏后的运行元信息；
- `transcript.md`：带时间戳转写稿；
- `subtitles.srt`：同一 cue 来源生成的字幕；
- `chapters.md`：已有 AI Insights 时的章节，否则给出缺失提示；
- `summary.md`：已有 AI Insights 时的摘要，否则给出缺失提示；
- `sources.json`：cue 级证据映射；
- `deliverable.md`：给后续 agent 读取的简短说明。

如果需要剪辑建议或会议纪要，先在 Subcast 完成对应语言的 AI Insights，再导出 `creator-brief` 或 `meeting-notes` 配方。

## 安全边界

- 只导入你明确提供的本机绝对路径。
- 授权只在当前 Subcast 会话内有效。
- agent 响应默认只暴露 hash 前缀、状态和下一步动作。
- 不在聊天中暴露原始路径、完整 hash、桌面 token、提示词或模型原文输出。
