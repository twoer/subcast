# Subcast — llama.cpp Integration Design Spec

> 用内置 `llama-server` sidecar 完全替换对 Ollama 的外部依赖。AI Insights / 翻译开箱即用，无需用户安装任何外部工具。
> 本文为 superpowers brainstorming 流程产出。下游：`writing-plans` 生成实施计划。

**版本**：v1.0
**创建日期**：2026-05-13
**关联**：
- `docs/superpowers/specs/2026-05-09-subcast-design.md`（V1.0 主设计，含初版 Ollama 集成）
- `docs/superpowers/specs/2026-05-12-ai-insights-design.md`（AI Insights 功能；本次重做其后端）
- 上游 `ggml-org/llama.cpp`（runtime）+ `ggerganov/whisper.cpp` 同生态

---

## 决策摘要

经一问一答 brainstorming 确认：

| 维度 | 选择 | 否决项 / 理由 |
|---|---|---|
| **Ollama 关系** | **彻底替换**，删除所有 Ollama 代码 | 保留双 backend = 持续维护两份；目标用户群体不需要"用我自己的 Ollama" |
| **DMG 内容** | 只塞 `llama-server` 二进制（~15 MB），模型按需下载 | 塞默认模型 (+2 GB DMG) 会显著拉高试用门槛；llamafile 单文件方案锁死模型 |
| **模型目录** | 仅 Qwen 2.5 三档（3B / 7B / 14B Q4_K_M） | 多家族 (DeepSeek/Llama) 测试矩阵爆炸；用户选择疲劳 |
| **lifecycle** | 懒启动 + 5 分钟空闲卸载 | 跟 Subcast 同生命周期 = 转录-only 用户白吃 5 GB RAM |
| **Windows 范围** | macOS 优先，Windows fast-follow（AI 在 Win v1 禁用） | 付费转录工具市场 macOS 主导 |
| **现有 GGUF 复用** | 扫描 LM Studio / Jan / `~/.cache/llama.cpp`，复用 whisperScan 模式 | Ollama blob 提取太复杂，跳过 |
| **API 契约** | OpenAI-compatible (`/v1/chat/completions`) | 未来切 inline / 云端 / BYOK 零业务代码改动 |
| **超时策略** | 动态：`input_tokens × 50ms + 30s base` | 固定 60s 会卡死长摘要 |
| **失败阈值** | 连续 3 次失败标 model unusable | — |
| **CI 测试** | 只 mock 层；真实 llama-server 留给本地 + 发版前 smoke | GitHub Actions 跑不动真模型；维护代价高 |
| **版本号** | 0.1.0 → **0.2.0** | user-facing 不兼容变更 |
| **回滚策略** | 不做开关，依赖手工降级 DMG | 内测期人数小（< 100），FF/灰度过度工程 |

---

## §1 — 架构概览

```
现在 (0.1)：
  Subcast (Electron) ──HTTP──▶ Ollama daemon (用户系统进程)
                               │
                               ▼
                              ~/.ollama/models/blobs/sha256-*

切换后 (0.2)：
  Subcast (Electron main)
    │
    ├─ desktop/llmServer.ts  ──spawn──▶  llama-server (sidecar 子进程)
    │                                     │
    │                                     ▼
    │                                    <userData>/models/llm/Qwen2.5-7B-Instruct-Q4_K_M.gguf
    │
    └─ Nitro (server/) ──HTTP──▶ llama-server (127.0.0.1:51302)
                                  - OpenAI-compat /v1/chat/completions
                                  - 模型懒加载、5 分钟空闲卸载
                                  - 同 Subcast 进程生命周期
```

**关键架构选择**：

1. **sidecar 模式 1:1 平行于现有 whisper-cli** —— 复用 `extraResources`、`binaryCheck.ts`、`ensureExecutable` ad-hoc 签名。
2. **OpenAI-compatible API** —— wire-compatible with OpenAI / Anthropic / 任意主流云。未来切 inline / cloud 不改业务代码。
3. **端口策略**：preferred `127.0.0.1:51302`（Nitro 用 51301），冲突时 fallback 到 `--port 0`，解析 stdout 提取实际端口。
4. **生命周期**：进 idle 5 分钟自动 SIGTERM；下次请求 lazy spawn；Subcast quit 时 before-quit handler 清理。
5. **完全无 Ollama 残留**：不检测、不调用、不依赖。用户系统已有 Ollama 跟 Subcast 互不影响。

---

## §2 — 文件改动地图

### 新增模块

| 文件 | 职责 |
|---|---|
| `desktop/llmServer.ts` | llama-server 子进程生命周期 mutex + state machine (`idle / starting / running / stopping`) |
| `desktop/modelManager/llmConfig.ts` | Qwen 三档 catalog（filename / size / sha256 / URL per mirror）、推荐档计算（按 hardware tier） |
| `desktop/modelManager/llmScan.ts` | 扫描 LM Studio / Jan / `~/.cache/llama.cpp` / Subcast 自家目录 |
| `desktop/modelManager/llmInstall.ts` | symlink / copy / download 三种安装方式（仿 `whisperInstall.ts`） |
| `desktop/orphanCleanup.ts` | 通用孤儿进程清理（启动时扫端口 + 进程名，whisper-cli 也会受益） |
| `server/utils/llmClient.ts` | `LLMBackend` 抽象 + `LlamaServerBackend` 实现；动态超时；3-次失败 unusable 标记 |
| `scripts/fetch-llama-server.mjs` | build-host 助手，从 GitHub Releases 拉 llama-server 二进制 |

### 新增 API（仿 whisper install 模式）

| Endpoint | 用途 |
|---|---|
| `server/api/desktop/llm/status.get.ts` | server state + active model + installed list |
| `server/api/desktop/llm/install.post.ts` | 启动 install task |
| `server/api/desktop/llm/install.get.ts` | 轮询安装进度 |
| `server/api/desktop/llm/install.delete.ts` | 取消安装 |
| `server/api/desktop/llm/[model].delete.ts` | 删除已安装模型（拒绝删 active） |

### 新增 CI

| 文件 | 用途 |
|---|---|
| `.github/workflows/build-llama-server.yml` | 仿 `build-whisper.yml`，矩阵 macOS arm64 (Metal) + Windows x64 (CPU only) |

### 修改

| 文件 | 改动 |
|---|---|
| `server/utils/settings.ts` | `ollamaModel` → `llmModel`，loadSettings 兼容老字段（丢弃） |
| `server/utils/insightTasks.ts` | 所有 Ollama HTTP 调用换 `llmClient` |
| `server/utils/insights.ts` | 同上 |
| `app/pages/setup-wizard.vue` | 删原 step 2 (Ollama 检测) 整步；原 step 3 (Qwen 拉取) 重写为新 step 2 (LLM 模型选择 + 扫描结果展示)；`currentStep` 类型从 `1\|2\|3` 改为 `1\|2`，3 步迁移逻辑里 step 3 引用全部移除 |
| `app/pages/settings.vue` | Models tab Ollama section → LLM section |
| `app/components/AppHeader.vue` | chip readiness：`ollamaReady` → `llmReady` |
| `app/composables/useActiveModels.ts` | 内部字段 `ollamaModel` → `llmModel`，对外接口不变 |
| `electron-builder.config.cjs` | extraResources 加 llama-server |
| `desktop/binaryCheck.ts` | REQUIRED_BINARIES 加 `'llama-server'`（缺失时启动期阻塞错误对话框） |
| `desktop/main.ts` | bootstrap **不**主动 spawn llama-server（懒启动）；before-quit SIGTERM 它 |
| `i18n/locales/{en,zh-CN}.json` | 加 LLM section，砍 Ollama / qwen 段 |
| `docs/smoke-tests.md` | 加 LLM 切换 smoke 清单 |
| `package.json` | 新增 `test:llm` script（本地 selective integration test，跳过 CI） |

### 删除

| 文件 | 理由 |
|---|---|
| `desktop/ollamaDetector.ts` | Q1 = 彻底替换 |
| `server/api/desktop/ollama/{status.get,fix-key.post,[name].delete}.ts` | 同上（fix-key 上游问题不存在了） |
| `server/api/desktop/qwen/pull.{get,post,delete}.ts` | 同上 |
| `server/utils/qwenPullTask.ts` | 同上 |
| `desktop/modelManager/qwen.ts` | 同上 |

---

## §3 — Setup Wizard 重构

### 步骤总数：3 → 2

```
现在 (0.1)：      Whisper ──▶ Ollama 检测 ──▶ Qwen 拉取
切换后 (0.2)：    Whisper ──▶ LLM 模型 (Qwen 三档)
```

### Step 2 UI（LLM 模型）

视觉结构完全复用现 Step 1（Whisper）：

- 三张卡片：3B / 7B / 14B Q4_K_M.gguf，配 size 标签和"推荐"badge
- 已就绪 badge（绿色）：canonical install location 有 GGUF 且 size + magic 合法
- "本机已有"hint：扫描到第三方 LLM 工具里有这个模型
- symlink / copy / ignore 三选一，仿 Whisper 流程
- 镜像切换下拉（默认 hf-mirror.com，可选 huggingface.co / modelscope.cn）

### 硬件 tier → 推荐档

```
< 8 GB RAM    → 3B（顶部加黄色警告"建议跳过 AI"）
8-16 GB       → 3B
16-32 GB      → 7B（推荐）
32+ GB        → 14B
```

### 扫描覆盖路径

`llmScan.ts` 默认扫描：

```
~/.cache/lm-studio/models/lmstudio-community/Qwen2.5-*-Instruct-GGUF/
~/.cache/llama.cpp/Qwen2.5-*/
~/Library/Caches/jan/models/Qwen2.5-*/
~/Library/Application Support/jan/data/models/Qwen2.5-*/
~/Library/Application Support/Subcast/models/llm/
~/.subcast/models/llm/
```

文件名正则：`/^Qwen2\.5-(3B|7B|14B)-Instruct-Q4_K_M\.gguf$/`

**不扫**：Ollama 的 `~/.ollama/models/blobs/`（blob 不是标准 GGUF，提取复杂度高，本期跳过）。

### 跳过设置

保留 footer "跳过设置"链接。跳过后：

- Settings → Models tab LLM section 显示"未配置，AI 不可用" + "立即配置"按钮跳回 wizard
- AppHeader chip LLM 一侧显示 `—` + 琥珀点（沿用 readiness 指示器）
- AI Insights 主界面按钮置灰

### 边界场景

| 场景 | 处理 |
|---|---|
| 8 GB Mac 进 step 2 | 顶部黄色警告 + 强化"跳过设置" |
| 磁盘空间不够 | `diskSpace.ts` 预检 → 下载按钮 disabled + tooltip |
| 多个 LLM 工具都装了 Qwen | UI 默认取 size 完整匹配且最大的；其他在折叠区给用户选 |

---

## §4 — 错误处理 + 生命周期

### 启动期

| 场景 | 用户看到 | 兜底 |
|---|---|---|
| llama-server 二进制缺失 | 启动阻塞对话框（同 whisper-cli） | `binaryCheck.ts` 已覆盖 |
| 不可执行 | 同上 | `afterPack` 自动 chmod 755 + ad-hoc codesign |
| 模型文件缺失 | 弹窗"未安装 LLM 模型" + 跳转 wizard | `llmClient.chat()` spawn 前 stat 模型 |

### 运行期

| 场景 | 用户看到 | 兜底 |
|---|---|---|
| llama-server SIGSEGV | "AI 推理失败 — 模型可能损坏" + 重新下载按钮 | SIGCHLD listener；连续 3 次失败标 model unusable |
| 系统 OOM kill (exit 137) | "AI 推理失败 — 内存不足，建议切换到更小模型" | 识别 exit code，提示降档 |
| 模型 load 失败 | "AI 模型损坏 — 重新下载？" | server 启动后 30s 内 /health 不通 → kill + 提示 |
| 推理超时 | 用户能取消 + 动态超时上限 | `input_tokens × 50ms + 30s base`，server 端 `--keep -1` |

### 并发 / 生命周期

| 场景 | 兜底 |
|---|---|
| 同时两请求 | llama-server 自身 serialize，客户端不加锁 |
| 请求到达时正在 idle-shutdown | 状态机 `stopping` 状态收到请求 → 取消 SIGTERM，转回 `running` |
| 用户 SIGKILL Subcast | 下次启动时 `orphanCleanup.ts` 扫端口 + process name 清理孤儿 |

### 端口管理

```
1. 尝试 bind 127.0.0.1:51302
2. 占用 → spawn 时传 --port 0
3. 解析 llama-server stdout "HTTP server listening on 127.0.0.1:NNNN" 提取实际端口
4. 写入 process.env.SUBCAST_LLM_PORT
5. 10s 内不 ready → 启动失败，弹错误
```

### 进程清理

```
正常退出: app.on('before-quit') → SIGTERM → 等 5s → SIGKILL → exit
SIGKILL: 下次启动 orphanCleanup.ts 处理
```

### 下载 / 磁盘

| 场景 | 处理 |
|---|---|
| 网络中断 | resume 续传（`downloader.ts` 已支持）|
| 镜像挂了 | HF → hf-mirror → modelscope 自动 fallback |
| 磁盘不够 | `diskSpace.ts` 预检拒绝 |
| Finder 删了模型文件 | stat fail → server 拒启 → UI 引导重新下载 |
| 下载中崩溃 | `.partial` 留下，下次 wizard 显示"继续下载" |

### 明确不做

- ❌ GPU / 温度监控（沙箱拒绝）
- ❌ 自动选量化精度（固定 Q4_K_M）
- ❌ 远程 URL 加载（只接受 wizard 镜像下载）
- ❌ 同时 load 两个模型（切模型 = stop 当前 + 下次启动用新的）

---

## §5 — App Store 未来路径 + 抽象层

### `LLMBackend` 接口（业务代码唯一依赖）

```typescript
export interface LLMBackend {
  chat(opts: LLMChatOptions): Promise<string>;
  chatStream(opts: LLMChatOptions): AsyncIterable<LLMChunk>;
}

export interface LLMChatOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMChunk {
  delta: string;
  finishReason?: 'stop' | 'length' | 'cancel';
}

export function createLLMBackend(): LLMBackend {
  if (process.env.SUBCAST_BUILD_TARGET === 'mas') {
    return new InlineLlamaCppBackend();   // 未来实现
  }
  return new LlamaServerBackend();         // 本期落地
}
```

### Backend 实现路线图

**A. `LlamaServerBackend`（本期）**

HTTP POST `127.0.0.1:51302/v1/chat/completions`，SSE 流式解析。调用前若 server 未启动，触发 `llmServer.ts` 懒 spawn。

**B. `InlineLlamaCppBackend`（App Store 切换时实现）**

- `import { getLlama, LlamaChatSession } from 'node-llama-cpp'`
- Nitro 进程内 load 模型，无独立 server 进程
- ABI rebuild 走 `ensure-sqlite-abi.mjs` 类似机制
- entitlements: `com.apple.security.cs.allow-jit` + `com.apple.security.cs.allow-unsigned-executable-memory`
- DMG +50 MB
- **业务代码零改动**

**C. `OpenAIBackend` / `AnthropicBackend`（未来 BYOK）**

- 用户在 settings 填 API key
- 离线时自动 fallback 到本地
- 渐进式开通，不冲突

### 本期 future-proofing 动作（半天）

1. 业务代码不直接调 fetch，一律 `llmClient` 抽象
2. `LLMBackend` 接口先写好（只有 LlamaServerBackend 一个实现）
3. OpenAI-compatible 数据格式当 lingua franca
4. `SUBCAST_BUILD_TARGET` env 注入接口（现在只用 `desktop-dmg`）
5. 模型路径 `<userData>/models/llm/` 对所有 backend 通用

### 不要做的过度抽象

- ❌ 预先实现 InlineLlamaCppBackend
- ❌ Backend switch UI（当下只有一个）
- ❌ Model registry 接口（catalog 写死 Qwen 三档）

### 切 App Store 时的预估工作量

按本期抽象做好，未来 MAS 切换：

| 任务 | 时间 |
|---|---|
| 实现 InlineLlamaCppBackend (~200 行) | 2 天 |
| ABI rebuild 集成 node-llama-cpp | 1 天 |
| Build target 分支：mas 砍 sidecar 相关 extraResources | 0.5 天 |
| MAS entitlements + Provisioning Profile | 1 天 |
| 砍 electron-updater | 0.5 天 |
| 测试 + 审核迭代 | 3-5 天 |
| **总计** | **8-10 天**（vs. 没抽象的话 14-18 天） |

---

## §6 — 测试策略

### 必跑（CI 每次 push）

| 测试 | 文件 | 覆盖 |
|---|---|---|
| llmServer 状态机 | `desktop/__tests__/llmServer.test.ts` | idle/starting/running/stopping 转换、并发 spawn 互斥、shutdown 期间收请求取消 shutdown |
| llmConfig 目录 | `desktop/modelManager/__tests__/llmConfig.test.ts` | catalog 完整性、tier 映射、mirror URL |
| llmScan 扫描 | `desktop/modelManager/__tests__/llmScan.test.ts` | mock fs，验证扫描结果、正则、size 过滤 |
| llmInstall symlink/copy | `desktop/modelManager/__tests__/llmInstall.test.ts` | 临时目录跑真实 symlink/copy，幂等性 |
| LlamaServerBackend mocked fetch | `server/utils/__tests__/llmClient.test.ts` | SSE 解析、cancel、动态超时 |
| 动态超时算法 | 同上 | input_tokens × 50ms + 30s base 的边界值 |
| Insights pipeline | `server/utils/__tests__/insights.test.ts` (改) | 用 mock LLMBackend 验证 prompt + 错误处理 |

**约束**：CI 测试 **不能依赖真实 llama-server 进程**。

### 选跑（本地 + release 前）

| 测试 | 触发 | 覆盖 |
|---|---|---|
| llama-server 真实 spawn + ready | `pnpm test:llm`（新脚本） | 真实启动 → /health → 最小 chat |
| OOM / 损坏 GGUF 恢复 | 同上 | corrupt GGUF 启动失败清理 |

### 手工 smoke（每次发版必走）

加入 `docs/smoke-tests.md`：

```
## LLM 切换 (0.2)
- [ ] reset-for-first-run → wizard step 2 显示三档
- [ ] 推荐档与硬件 tier 一致（16GB Mac 推荐 7B）
- [ ] LM Studio 已有 7B 时被扫到 + symlink 成功
- [ ] hf-mirror.com 默认下载 3B 走通
- [ ] 跳过 wizard step 2 → 主界面 AI 按钮置灰 + AppHeader 琥珀点
- [ ] 转录完成 → AI Insights → 第一次 ~3s（model load）→ 后续即时
- [ ] 5 分钟不用 AI → llama-server 自动 stop（RAM 释放）
- [ ] 再次 AI 请求 → 重新 spawn 成功
- [ ] settings → 切到 14B → 旧 server stop / 新模型启动
- [ ] settings → 删除 active 模型 → 拒绝 409
- [ ] 删除非 active 模型 → 成功
- [ ] Cmd+Q → llama-server 5s 内消失（ps aux | grep llama-server）
- [ ] kill -9 后再启 → orphanCleanup 清掉
```

### 回归覆盖（确保不破现有功能）

| 功能 | 验证 |
|---|---|
| Whisper 转录 | `whisperScan.test.ts` 已有 |
| AI Insights | `insights.test.ts` mock 改成 LLMBackend |
| 翻译 | 同上 |
| Settings load/save | 写迁移 test：老 `{ ollamaModel }` → 新 `{ llmModel: undefined }`（丢弃旧值） |

### 不做的测试

- ❌ 模型推理质量评测（BLEU 等）
- ❌ 并发性能测试
- ❌ 重写 downloader 测试

---

## §7 — 发版 / 迁移

### 版本号

`0.1.0 → 0.2.0`（user-facing 不兼容变更）。

### 升级路径

```
1. electron-updater 推 0.2 → 重启
2. settings.ollamaModel 被 loadSettings 丢弃
3. <userData>/models/llm/ 空 → AI 不就绪
4. setup-check.vue 跳 setup-wizard
5. wizard step 1 Whisper 已就绪 → 下一步
6. wizard step 2 (新 LLM):
   - 老 settings 智能预选档（'qwen2.5:7b' → 7B 档）
   - 用户选：现在下载 / 跳过（settings 后续配）
7. ~/.ollama 不动；release notes 提示用户自行清理
```

### Settings 字段迁移

`loadSettings()` 兼容：

```typescript
if ('ollamaModel' in parsed) {
  const { ollamaModel: _, ...rest } = parsed;
  return { ...DEFAULT_SETTINGS, ...rest };
}
```

老值在 wizard 首次显示时**作为推荐档预选**（一次性 hint 文件 `<userData>/models/llm/.migration-hint.json`，wizard 读完即删）。

### 工程实施顺序（8-10 工作日）

| Phase | 工时 | 产出 |
|---|---|---|
| **P0: CI build** | 1 天 | `.github/workflows/build-llama-server.yml` 跑通 |
| **P1: 抽象 + sidecar 进程** | 2 天 | `llmServer.ts` + `llmClient.ts` + `LLMBackend` 接口 + 单测 |
| **P2: catalog + downloader + scan** | 1.5 天 | `llmConfig.ts` + `llmInstall.ts` + `llmScan.ts` + API endpoints + 测试 |
| **P3: 业务代码切换** | 1 天 | `insightTasks.ts` / `insights.ts` 改用 `llmClient`，删 Ollama 直连 |
| **P4: Wizard UI** | 1.5 天 | step 2 重写为 LLM 选择 + 扫描，删原 step 2 |
| **P5: Settings + AppHeader** | 1 天 | settings models tab LLM section；header chip readiness 改名；i18n |
| **P6: 删 Ollama 残留** | 0.5 天 | 砍 detector / ollama endpoints / qwen 相关 / composables 字段 |
| **P7: 测试 + smoke** | 1 天 | 跑完所有 CI + smoke 清单 |
| **P8: 发版** | 0.5 天 | 0.2.0、release notes、GitHub Release、验证 electron-updater |

P0 独立可并行，P1 → P2 → P3 串行，P4/P5 可并行，P6 在 P3 后任意时间。

### Release notes 草稿（双语）

```markdown
## 0.2.0 — 内置 AI 推理引擎

**主要变化：Subcast 不再需要 Ollama**

- 内置 llama.cpp 推理引擎，AI Insights / 翻译开箱即用
- 模型在 setup wizard 里直接下载，支持 hf-mirror / ModelScope 国内镜像
- LM Studio / Jan / ~/.cache/llama.cpp 已有的 Qwen GGUF 可一键复用（symlink 或 copy）
- AI 推理懒启动 + 5 分钟空闲卸载，转录-only 场景 ~0 额外 RAM
- 砍掉 Ollama 检测和 Qwen 拉取步骤，setup wizard 从 3 步减为 2 步

**0.1 用户须知**：升级后第一次启动会进 setup wizard step 2（LLM 模型）。如果你之前装的
Ollama 仅用于 Subcast，现在可以卸载它（Subcast 不再使用 ~/.ollama 里的数据）。

**新硬件门槛**：3B 模型 8 GB RAM，7B 模型推荐 16 GB+。8 GB Mac 会建议跳过 AI 设置。
```

### 回滚预案

如果 0.2.0 翻车（内测期约 5%）：

- electron-updater 不支持自动降级，但 GitHub Releases 老版本 DMG 还在
- 用户手动重装 0.1.0 → 老 `ollamaModel` 字段重新生效（0.1 settings.ts 读它）→ 走 Ollama 路径
- 要求 **0.2 版本不动 Whisper / cue / library / 字幕这些核心模块** —— 单点改动

### 不在本次范围

- 不上 App Store（仍 Developer ID + DMG 直发）
- 不做 BYOK（抽象层留接口，下次再说）
- 不支持 GGUF 量化级别切换（固定 Q4_K_M）
- 不做 Windows（fast-follow）

---

## 附录 A — llama-server 启动参数

```
llama-server \
  --model <userData>/models/llm/Qwen2.5-7B-Instruct-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 51302 \
  --ctx-size 8192 \
  --threads <CPU_COUNT - 2> \
  --n-gpu-layers 999 \
  --metal \                     # macOS arm64 only
  --keep -1 \                   # 防 KV cache 自动 truncate
  --log-format json
```

`--n-gpu-layers 999` 让所有 layer 都上 GPU；Apple Silicon 上 Metal 自动启用。Windows x64（v1 不支持 AI）/ Intel Mac 落到 CPU only。

## 附录 B — Qwen 三档 GGUF URL（pin 死的版本）

```typescript
const CATALOG = {
  '3b': {
    filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 1_930_000_000,
    sha256: '<TBD - 实施时填上游 publish 的 sha>',
    urls: {
      huggingface: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
      'hf-mirror': 'https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
      'modelscope': 'https://modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/master/qwen2.5-3b-instruct-q4_k_m.gguf',
    },
  },
  '7b': { /* 同上，~4.5 GB */ },
  '14b': { /* 同上，~9.0 GB */ },
};
```

具体 sha256 在 P1 实施时从上游 publish meta 拿；不要在 spec 阶段填假值。

---

## 决策依赖图

```
Q1 (彻底替换 Ollama)
  ├─ §2: 删除 Ollama 相关文件
  ├─ §3: setup wizard 3→2 步
  └─ §7: 0.2 大版本号 + release notes 必须明说

Q2 (DMG 只 +15 MB binary)
  └─ §3: setup wizard 必须有"下载模型"步骤
  └─ §7: 用户首启要等下载

Q3 (Qwen 三档)
  ├─ §2: llmConfig.ts catalog 写死 3 档
  ├─ §3: wizard 显示 3 张卡片
  └─ §6: 测试矩阵就 3 个 model id

Q4 (懒启动 + 5min idle)
  ├─ §1: 进程生命周期状态机
  ├─ §4: 并发请求 / shutdown 期处理
  └─ §6: smoke 测试要验证空闲卸载

Q5 (Windows fast-follow)
  ├─ §2: build-llama-server.yml 矩阵含 Windows，但 Windows 版本 v1 禁用 AI
  └─ §7: release notes 不提 Windows AI

Q6 (扫描 LM Studio/Jan 不扫 Ollama)
  ├─ §2: llmScan.ts 写死 5 个路径
  └─ §3: wizard 显示扫描结果 + symlink/copy 选项
```

---

**Spec 完成。下游：`writing-plans` skill 生成可执行实施计划。**
