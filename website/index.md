---
layout: home
title: 免费离线音视频转写翻译（飞书妙记平替）
description: Subcast 是飞书妙记、通义听悟等云端转写工具的本地免费平替：SenseVoice + Whisper 双引擎离线转写、本地 LLM 翻译与 AI 摘要，数据不离开你的电脑。

hero:
  name: Subcast
  text: 离线音视频转写与翻译
  tagline: 免费 · 离线 · 隐私优先 —— 本地转写 + 本地 LLM 翻译 / 摘要，数据不离开你的机器
  image:
    src: /demo/player.webp
    alt: Subcast 播放器界面
  actions:
    - theme: brand
      text: 下载 macOS
      link: https://github.com/twoer/subcast/releases/latest
    - theme: alt
      text: 快速上手
      link: /guide/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/twoer/subcast

features:
  - icon: 🔒
    title: 隐私优先
    details: 所有数据与推理都在本地完成。敏感音视频不上传任何服务器，无遥测、无上报。
  - icon: 🎙
    title: 双引擎转写
    details: 内置 SenseVoice（中英日韩粤，CPU 提速约 15 倍）+ 按需下载的 Whisper（99 语言、词级时间戳），自动按音频语言分发。
  - icon: 💸
    title: 零持续成本
    details: 不依赖任何云端 API。下载模型后，零费用、零订阅。
  - icon: 🌍
    title: 多语言翻译
    details: 本地 Qwen3 翻译任意目标语言，播放器内实时切换，已缓存语言秒切。
  - icon: ✨
    title: AI 摘要 + 章节
    details: 一键生成本地 LLM 流式摘要与可点击的章节标记。
  - icon: 📥
    title: 字幕导出
    details: 单语 / 双语 / 多语字幕一键导出（VTT / SRT / TXT）。
  - icon: ⚡
    title: 流式 + 批处理
    details: 转写过程中即可开始观看；多文件批处理会先完成整批转写和关键字幕结果，再继续增强任务。
  - icon: 🔍
    title: 全文搜索
    details: 播放器内常驻搜索框，匹配高亮，Enter 循环跳转。
  - icon: 🧭
    title: 模型状态可见
    details: 设置页区分转写模型与 AI 模型运行状态，看清何时运行、加载或自动释放。
---

<HomeCompare />
