---
description: Subcast 下载与安装指南：macOS 系统要求、DMG 安装步骤、首次打开提示「已损坏」的解决方法。
---

# 安装

## 系统要求

| 配置 | 最低 | 推荐 |
|------|------|------|
| 系统 | macOS 13+（Apple Silicon） | macOS 14+ |
| 内存 | 8 GB | 16 GB 及以上 |
| 磁盘 | 1 GB（应用 + 内置模型） | 10 GB（含 AI 翻译模型） |

安装包已内置 SenseVoice 转写模型（约 250 MB），**装完即用、无需联网下载**。AI 翻译 / 摘要模型（Qwen3）在首次使用时按需下载。

## 下载

从 [GitHub Releases](https://github.com/twoer/subcast/releases/latest) 下载最新 `.dmg`。

## 安装步骤

1. 双击打开 `.dmg`；
2. 将 Subcast 拖入 `Applications` 文件夹；
3. 首次打开如果 macOS 提示「已损坏」（Gatekeeper 对未签名 app 的拦截，并非真的损坏），在终端执行：

```bash
xattr -cr /Applications/Subcast.app
```

然后双击即可正常打开。

## Windows / Linux

Windows 版本正在开发中，将在后续版本发布。当前仅支持 macOS Apple Silicon。
