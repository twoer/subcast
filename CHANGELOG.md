# Changelog

## 0.2.0 — 2026-05-13

### 内置 AI 推理引擎 / Bundled AI inference engine

**主要变化 / Major change**：Subcast 不再需要 Ollama。AI Insights / 翻译开箱即用。
Subcast no longer requires Ollama. AI Insights / translation work out of the box.

#### 新增 / Added
- 内置 `llama.cpp` 推理引擎（`llama-server` sidecar，~15 MB binary）
  Bundled `llama.cpp` inference engine (`llama-server` sidecar, ~15 MB binary)
- 模型下载 UI 直接在 setup wizard 内，支持 huggingface / hf-mirror / modelscope 镜像
  Model download UI inside setup wizard, supports huggingface / hf-mirror / modelscope mirrors
- 自动扫描 LM Studio / Jan / `~/.cache/llama.cpp` 已有的 Qwen GGUF，提供 symlink / copy 复用
  Auto-scan existing Qwen GGUF files in LM Studio / Jan / `~/.cache/llama.cpp` with symlink / copy reuse
- AI 推理懒启动 + 5 分钟空闲卸载，转录-only 场景下零额外 RAM
  Lazy-spawn + 5-minute idle shutdown of inference server — zero extra RAM when not using AI
- 启动时自动清理上次崩溃残留的 sidecar 进程
  Auto-cleanup of orphan sidecar processes from prior crashes at boot
- Settings → Models 标签页新增 LLM 管理（切换 / 删除 / 跳转下载更多）
  Settings → Models tab — LLM management (switch / delete / download more)

#### 变更 / Changed
- Setup wizard 从 3 步减为 2 步（删除 Ollama 检测步骤）
  Setup wizard collapsed from 3 steps to 2 (Ollama detection step removed)
- AppHeader 模型 chip 现在显示 Whisper · LLM 档位 id，琥珀色点表示未安装
  AppHeader model chip now shows Whisper · LLM tier id, amber dot indicates uninstalled
- 翻译管线改走 `LLMBackend` 抽象，未来切换推理后端（云端 / Apple Intelligence）只需替换一个文件
  Translation pipeline routed through `LLMBackend` abstraction; future backend swaps (cloud / Apple Intelligence) are single-file changes

#### 删除 / Removed
- 所有 Ollama 检测、Qwen pull、`~/.ollama/id_ed25519` 修复相关代码
  All Ollama detection, Qwen pull, `~/.ollama/id_ed25519` fix-key code paths

### 0.1 用户升级须知 / Upgrade notes for 0.1 users
升级后首次启动会进入 setup wizard step 2（LLM 模型），从 `settings.ollamaModel` 智能预选档位。如果之前装的 Ollama 仅用于 Subcast，现在可以卸载（Subcast 不再读取 `~/.ollama/`）。
After upgrading, first launch enters setup wizard step 2 (LLM model), with tier pre-selected from your legacy `settings.ollamaModel`. If your Ollama install was Subcast-only, you can uninstall it now — Subcast no longer reads `~/.ollama/`.

### 硬件门槛 / Hardware requirements
- 3B model: 8 GB RAM minimum
- 7B model: 16 GB RAM recommended
- 14B model: 32 GB RAM recommended (Apple Silicon)
- 8 GB Mac 用户在 wizard 中会看到提示，建议跳过 AI 设置
  8 GB Mac users see a warning in the wizard suggesting to skip AI setup
