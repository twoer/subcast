---
description: Subcast 模型管理：SenseVoice / Whisper / Qwen3 模型的下载档位、磁盘占用与软链接复用说明。
---

# 模型管理

所有模型在 设置 → 模型 中管理。

## 转写引擎

- **SenseVoice**（250 MB）：安装包内置，首启自动就位；删除后可在设置页重新下载；
- **Whisper**（77 MB – 1.6 GB）：tiny / base / small / medium / large-v3-turbo 五档按需下载，支持从 LM Studio、Jan 等已有文件软链接（不重复占空间）。

## AI 翻译模型（Qwen3）

| 档位 | 体积 | 推荐内存 |
|------|------|----------|
| 4B | 2.5 GB | 8 GB |
| 8B | 5.0 GB | 16 GB |
| 14B | 9.0 GB | 32 GB |

设置页会按本机内存给出推荐档位。从 Qwen 2.5 升级的用户，旧模型文件可在设置页一键清理释放空间。

## 模型存放位置

`~/Library/Application Support/Subcast/models/`（macOS）。删除模型不影响已完成的转写与翻译缓存。
