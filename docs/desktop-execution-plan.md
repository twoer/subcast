# Subcast 桌面化执行方案

> 配套文档：[`docs/desktop-packaging.md`](./desktop-packaging.md) (v5 设计) — 决策的"为什么"
> 本文档：执行的"怎么做" — file-by-file 任务 + 每项 DOD + 命令片段
> 总预估：**6-8 周**（团队首次做 Electron 加 1-2 周 buffer）
> 起步版本：`0.1.0`

---

## 〇、整体时间表

| Phase | 周期 | 内容 | 关键产出 |
|-------|------|------|---------|
| Phase 0 | 0.5 天 | 工具链 + 仓库准备 | LICENSE / 依赖 / CI 仓库就绪 |
| Phase 1 | 2-3 周 | Electron 骨架 + Nitro 内嵌 + 原生依赖打包 | 能打出 .dmg / .exe，启动后 `/api/health = 200` |
| Phase 2 | 1-2 周 | 首次运行向导 + 模型管理 | 全新机器能跑完向导到主界面 |
| Phase 3 | 1 周 | 桌面增强（托盘、菜单、About、Export Diagnostics）| 完整桌面体验，可隐藏到托盘 |
| Phase 4 | 1 周 | 签名（self-signed Win）+ 自动更新 | v0.1.0 → v0.1.1 自动更新跑通 |
| Phase 5 | 1-1.5 周 | i18n + 测试 + 文档 + 发布 | v0.1.0 发布到 GitHub Releases |

每个 Phase 章节里：
- **任务清单**：file-by-file，每条带 DOD（Definition of Done）
- **依赖关系**：标注前置任务
- **里程碑**：Phase 完成的验收标准

---

## Phase 0 — 工具链 + 仓库准备（0.5 天）

### 0.1 工具链确认

- [ ] **0.1.a** Node.js 22.x + pnpm 9.12+ 已装
  - 命令：`node -v && pnpm -v`
  - DOD：Node ≥ 22.0、pnpm ≥ 9.12
- [ ] **0.1.b** macOS 测试机：macOS 15+ Sequoia + arm64
  - DOD：能跑 `xcrun --version`、能 `cmake` whisper.cpp
- [ ] **0.1.c** Windows 测试机：Windows 11 x64（VM 或物理机）+ PowerShell
  - DOD：能跑 `New-SelfSignedCertificate` + `signtool.exe`
- [x] **0.1.d** Electron 版本：**v42.0.1**（2026-05-12 拉的最新 stable）
- [x] **0.1.e** whisper.cpp tag：**v1.8.4**（2026-05-12 拉的最新 stable，比 v5 doc 占位的 v1.7.x 新一个大版本）

### 0.2 仓库基础设施

- [ ] **0.2.a** 创建 `LICENSE` 文件（AGPL v3 全文）
  - 命令：`curl https://www.gnu.org/licenses/agpl-3.0.txt > LICENSE`
  - DOD：文件存在，第一行是 "GNU AFFERO GENERAL PUBLIC LICENSE"
- [ ] **0.2.b** 更新 `package.json`
  ```diff
  - "private": true,
  + "license": "AGPL-3.0-or-later",
  + "author": "twoer",
  + "homepage": "https://github.com/twoer/subcast",
  + "repository": { "type": "git", "url": "https://github.com/twoer/subcast.git" },
  ```
  - DOD：`pnpm install` 不报错
- [ ] **0.2.c** 给所有 `app/**/*.{vue,ts}` + `server/**/*.ts` + `desktop/**/*.ts` 加 SPDX header（脚本 `scripts/add-spdx.mjs`）
  - SPDX 行：`/* SPDX-License-Identifier: AGPL-3.0-or-later */`
  - DOD：每个源文件首行有 SPDX 注释；脚本幂等（再跑一次不重复添加）
- [ ] **0.2.d** 重写 `README.md`（英文）顶部加 callout：
  ```markdown
  > ⚠️ **First-time setup requires internet**: Once Whisper, Ollama, and Qwen models
  > are downloaded, all transcription and translation runs 100% locally with zero data egress.
  ```
- [ ] **0.2.e** 创建 `README.zh.md`（中文对应）

### Phase 0 DOD

- [ ] `LICENSE` 文件存在，AGPL v3 全文
- [ ] `package.json` 含 license / author / repository
- [ ] 所有源文件首行 SPDX header
- [ ] README.md + README.zh.md 含联网 callout
- [ ] 决定的 Electron 版本和 whisper.cpp tag 已记录

---

## Phase 1 — 基础架构（2-3 周）

### Week 1：Electron 骨架 + Nitro 内嵌

#### 1.1 desktop/ 目录骨架（Day 1）

- [ ] **1.1.a** 创建目录结构：
  ```
  desktop/
  ├── main.ts
  ├── preload.ts
  ├── types.ts
  ├── nitroEmbed.ts
  └── platform/
      ├── darwin.ts
      └── win32.ts
  ```
- [ ] **1.1.b** `desktop/types.ts` 定义 `SubcastWindowAPI` 接口
  ```ts
  export interface SubcastWindowAPI {
    isDesktop: true;
    platform: NodeJS.Platform;
    appVersion: string;
    apiToken: string;
  }
  ```
- [ ] **1.1.c** 安装 Electron 依赖
  ```bash
  pnpm add -D electron electron-builder electron-rebuild
  pnpm add -D @electron/rebuild   # 较新的官方推荐
  pnpm add -D @types/electron
  ```
- [ ] DOD：`pnpm install` 通过；`node_modules/electron/dist/Electron.app` 存在（macOS）

#### 1.2 Nuxt SPA 桌面构建（Day 2）

- [ ] **1.2.a** 创建 `nuxt.desktop.config.ts`：
  ```ts
  import config from './nuxt.config';
  export default { ...config, ssr: false, nitro: { ...config.nitro, preset: 'node' } };
  ```
- [ ] **1.2.b** `package.json` scripts 加：
  ```jsonc
  "build:desktop:assets": "nuxi build --config nuxt.desktop.config.ts",
  ```
- [ ] **1.2.c** 跑一次构建
  - 命令：`pnpm build:desktop:assets`
  - DOD：`.output/public/index.html` 存在；`.output/server/index.mjs` 存在

#### 1.3 主进程 import Nitro（Day 3）

- [ ] **1.3.a** `desktop/nitroEmbed.ts`：端口策略 + Nitro 启动
  ```ts
  import { randomUUID } from 'node:crypto';

  export async function startNitro(): Promise<{ port: number; token: string }> {
    const token = randomUUID();
    process.env.SUBCAST_API_TOKEN = token;
    process.env.SUBCAST_DESKTOP = 'true';

    const PREFERRED_PORT = 51301;
    let port = PREFERRED_PORT;
    // ... try preferred port, fallback to listen(0)
    await import('../.output/server/index.mjs');
    return { port, token };
  }
  ```
- [ ] **1.3.b** `desktop/main.ts` 主进程入口
  - app.whenReady → startNitro() → createWindow()
  - 启动失败 → `dialog.showMessageBox` (决策 23)
- [ ] DOD：`pnpm dev:desktop` 启动后能看到 stdout 含 "Nitro listening on 51301"；`curl http://localhost:51301/api/health` 返回 200

#### 1.4 BrowserWindow + 主窗口（Day 4）

- [ ] **1.4.a** `pnpm add -D electron-window-state`
- [ ] **1.4.b** `desktop/main.ts` createWindow 实现：
  - 决策 14：首启 `win.maximize()`，后续 electron-window-state 恢复
  - 决策 19：注入 `<html class="dark">` (用 `did-finish-load` + executeJavaScript)
  - decision 11：close → hide to tray (拦截 `close` event)
  - `webPreferences.contextIsolation: true`
  - `webPreferences.nodeIntegration: false`
  - `webPreferences.sandbox: true`
- [ ] **1.4.c** `win.loadURL(\`http://localhost:${port}\`)`
- [ ] DOD：双击 dev 启动 → 看到 Nuxt 主界面 + 主界面是暗色 + 窗口最大化

#### 1.5 preload + window.subcast（Day 5）

- [ ] **1.5.a** `desktop/preload.ts`：
  ```ts
  import { contextBridge } from 'electron';
  const api: SubcastWindowAPI = {
    isDesktop: true,
    platform: process.platform,
    appVersion: process.env.npm_package_version!,
    apiToken: process.env.SUBCAST_API_TOKEN!,
  };
  contextBridge.exposeInMainWorld('subcast', api);
  ```
- [ ] **1.5.b** `app/composables/useDesktop.ts`（新增）
- [ ] DOD：DevTools 控制台 `window.subcast` 输出完整对象

#### 1.6 鉴权 middleware（Day 5-6）

- [ ] **1.6.a** `server/middleware/auth-desktop.ts`（新增）
  ```ts
  export default defineEventHandler((event) => {
    if (process.env.SUBCAST_DESKTOP !== 'true') return;
    if (event.path === '/api/health') return;
    const expect = process.env.SUBCAST_API_TOKEN;
    const got = getHeader(event, 'x-subcast-token');
    if (got !== expect) throw createError({ statusCode: 401, statusMessage: 'BAD_TOKEN' });
  });
  ```
- [ ] **1.6.b** `app/plugins/desktop-fetch.client.ts`（新增）
  - 桌面环境给所有 `$fetch` 自动附 `x-subcast-token` header
- [ ] **1.6.c** 测试：去掉 token header 调 `/api/transcribe` 应返回 401
- [ ] DOD：桌面环境前端能正常调 API；不带 token 直接 curl 返回 401

### Week 2：原生依赖打包 + CI

#### 1.7 better-sqlite3 electron-rebuild（Day 7-8）

- [ ] **1.7.a** `package.json` scripts 加：
  ```jsonc
  "build:desktop:native": "electron-rebuild -f -w better-sqlite3"
  ```
- [ ] **1.7.b** macOS 本地跑通：
  ```bash
  pnpm build:desktop:native
  ls node_modules/better-sqlite3/build/Release/better_sqlite3.node
  ```
- [ ] **1.7.c** dev:desktop 时验证 SQLite migrate 不抛 `NODE_MODULE_VERSION`
- [ ] DOD：dev 启动后 `db.prepare("SELECT 1").get()` 不报错

#### 1.8 whisper-cli CI 矩阵（Day 9-11）

- [ ] **1.8.a** `.github/workflows/build-whisper.yml`：
  ```yaml
  name: Build whisper-cli
  on:
    push:
      paths: ['.github/workflows/build-whisper.yml']
    workflow_dispatch:
  env:
    WHISPER_CPP_VERSION: v1.7.5  # 见 Phase 0.1.e 确认
  jobs:
    build:
      strategy:
        matrix:
          include:
            - os: macos-14
              arch: arm64
              ext: ''
              cmake_flags: '-DGGML_METAL=ON'
            - os: windows-latest
              arch: x64
              ext: '.exe'
              cmake_flags: ''
      runs-on: ${{ matrix.os }}
      steps:
        - run: git clone --depth 1 --branch ${{ env.WHISPER_CPP_VERSION }} https://github.com/ggerganov/whisper.cpp
        - working-directory: whisper.cpp/build
          run: cmake .. ${{ matrix.cmake_flags }} && cmake --build . --target whisper-cli --config Release
        - uses: actions/upload-artifact@v4
          with:
            name: whisper-cli-${{ matrix.os }}-${{ matrix.arch }}
            path: whisper.cpp/build/bin/whisper-cli${{ matrix.ext }}
  ```
- [ ] **1.8.b** 手动触发一次 workflow，下载 artifact 验证
- [ ] **1.8.c** `scripts/fetch-whisper-cli.mjs`：从最新 Action artifact 下载二进制到本地 `binaries/`
- [ ] **1.8.d** `binaries/` 加入 `.gitignore`
- [ ] DOD：本机 `binaries/darwin-arm64/whisper-cli` + `binaries/win32-x64/whisper-cli.exe` 存在且能跑 `--help`

#### 1.9 ffmpeg-static（Day 12）

- [ ] **1.9.a** `pnpm add ffmpeg-static`（LGPL 构建）
- [ ] **1.9.b** 改 `server/utils/ffmpeg.ts`：
  ```ts
  const IS_DESKTOP = process.env.SUBCAST_DESKTOP === 'true';
  const FFMPEG_PATH = IS_DESKTOP
    ? join(process.resourcesPath, 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''))
    : require('ffmpeg-static');
  ```
- [ ] DOD：dev:desktop 下 probeDurationS 一个真实视频文件成功返回时长

#### 1.10 路径常量改造（Day 13）

- [ ] **1.10.a** `server/utils/whisperPaths.ts` 加 `IS_DESKTOP` 分支（已在 v5 § 4.4 给出示例）
- [ ] **1.10.b** `server/utils/db.ts` 改 `SUBCAST_HOME = process.env.SUBCAST_HOME ?? join(homedir(), '.subcast')`，桌面版主进程在 import Nitro 前注入
- [ ] DOD：dev:desktop 启动后 `~/Library/Application Support/Subcast/data.sqlite` 被创建

### Week 3：electron-builder 打包

#### 1.11 Icon 生成（Day 14）

- [ ] **1.11.a** `pnpm add -D sharp svg2icns electron-icon-builder`
- [ ] **1.11.b** `scripts/generate-icons.mjs`：
  - 用 sharp 把 `public/favicon.svg` 渲染到 1024×1024 PNG
  - 再用 electron-icon-builder 转 .icns + .ico
- [ ] **1.11.c** 加 npm script `"build:desktop:icons"`
- [ ] DOD：`assets/icon.icns` + `assets/icon.ico` 存在；Finder 预览 icns 不模糊；Windows 资源管理器预览 ico 不模糊

#### 1.12 electron-builder 配置（Day 15-16）

- [ ] **1.12.a** `electron-builder.config.json5`（决策 1 / 9 / 12 / 24 都体现）：
  ```jsonc
  {
    "appId": "io.github.twoer.subcast",
    "productName": "Subcast",
    "copyright": "© 2026 twoer",
    "directories": { "output": "dist-electron" },
    "files": ["desktop/**/*", ".output/**/*", "node_modules/**/*"],
    "extraResources": [
      { "from": "node_modules/ffmpeg-static/ffmpeg${ext}", "to": "ffmpeg${ext}" },
      { "from": "binaries/${os}-${arch}/whisper-cli${ext}", "to": "whisper-cli${ext}" }
    ],
    "fileAssociations": [
      { "ext": ["mp4", "mkv", "mov", "webm", "m4a", "mp3", "wav"], "role": "Viewer" }
    ],
    "mac": {
      "target": ["dmg"],
      "icon": "assets/icon.icns",
      "identity": null
    },
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
      "deleteAppDataOnUninstall": false
    }
  }
  ```
- [ ] **1.12.b** `package.json` scripts：
  ```jsonc
  "build:desktop": "pnpm build:desktop:icons && pnpm build:desktop:assets && pnpm build:desktop:native && electron-builder",
  "build:desktop:mac": "... --mac",
  "build:desktop:win": "... --win"
  ```
- [ ] DOD：`pnpm build:desktop:mac` 跑通，产出 `dist-electron/Subcast-0.1.0-arm64.dmg`（~250MB）

#### 1.13 单实例锁 + 文件关联（Day 17）

- [ ] **1.13.a** `desktop/main.ts` 加 `requestSingleInstanceLock`（决策 20）：
  ```ts
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); process.exit(0); }
  app.on('second-instance', (_, argv) => {
    // 唤醒已有窗口 + 取 argv 里的文件路径转 IPC
  });
  ```
- [ ] **1.13.b** `app.on('open-file')`（macOS）+ `process.argv` 解析（Windows）→ IPC 发给 renderer
- [ ] **1.13.c** Renderer 接 IPC："收到文件路径 → 自动触发上传流程"
- [ ] DOD：双击两次 .app 只起一个窗口；右键 .mp4 选 "用 Subcast 打开" 能传文件到主界面

#### 1.14 Windows self-signed 证书（Day 18）

- [ ] **1.14.a** 本机 PowerShell 跑：
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
- [ ] **1.14.b** `.pfx` base64 → GitHub Actions Secrets `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`
- [ ] DOD：手动 `pnpm build:desktop:win` 产出 `.exe`，右键属性 → Digital Signatures 标签能看到 "Subcast (twoer)"

### Phase 1 里程碑（验收清单）

- [ ] macOS arm64 `.dmg` 双击 → 拖到 Applications → 右键打开（macOS 14）或系统设置允许（macOS 15+）→ 主界面出现，最大化，暗色
- [ ] Windows x64 `.exe` 双击 → SmartScreen "More info" → "Run anyway" → 安装 → 启动后主界面出现
- [ ] `/api/health` 在主进程 Nitro 上返回 200
- [ ] 不带 token 调 `/api/transcribe` 返回 401，带正确 token 通过
- [ ] 双击两次 .app 只起一个实例
- [ ] 关闭窗口（×）会**真的退出**（Phase 3 才改成隐藏托盘，这里先验证 close 行为正常）
- [ ] `window.subcast` 在 DevTools 输出完整对象
- [ ] better-sqlite3 在两平台都不抛 ABI 错误
- [ ] CI build-whisper.yml 至少跑通一次

---

## Phase 2 — 首次运行向导（1-2 周）

### 2.1 通用下载器（Day 1-2）

- [ ] **2.1.a** `desktop/modelManager/downloader.ts`
  - Range header 续传
  - SHA256 校验
  - 进度回调（每 500ms 触发一次，避免 IPC 噪音）
- [ ] **2.1.b** 单元测试：mock fetch + Readable stream，验证续传 + 校验失败重试
- [ ] DOD：单元测试通过；能下一个真实小文件（如 ggml-tiny.bin 77MB）

### 2.2 Whisper 模型扫描（决策 34，Day 3）

- [ ] **2.2.a** `desktop/modelManager/whisperScan.ts`
  - 扫描路径列表（v5 § 5.7）
  - SHA256 比对（按已知 hash 列表识别哪个档位）
  - 返回 `{name, path, source}[]`
- [ ] **2.2.b** 单元测试：mock fs.readdir，验证扫描逻辑
- [ ] DOD：dev 机有 `~/.subcast/...models/ggml-base.bin` 时能识别出来

### 2.3 磁盘空间预检（决策 22，Day 4）

- [ ] **2.3.a** `pnpm add check-disk-space`
- [ ] **2.3.b** `desktop/diskSpace.ts`（v5 § 6.11 已给实现骨架）
- [ ] **2.3.c** 单元测试：mock check-disk-space 返回不同 free 值
- [ ] DOD：模型下载前调 `checkSpaceForModel` 在空间不足时返回 ok=false

### 2.4 Setup Check 路由（Day 5）

- [ ] **2.4.a** `app/pages/setup-check.vue`（新增）
  - useDesktop 守卫
  - 调 `/api/health`、`/api/desktop/setup-status`（新 endpoint）
- [ ] **2.4.b** `server/api/desktop/setup-status.get.ts`（新增）
  - 返回 `{ hasWhisperModel: boolean, ollamaRunning: boolean, hasQwen: boolean }`
  - 桌面环境才暴露（auth-desktop middleware 已保护）
- [ ] **2.4.c** Setup check 逻辑：
  - 全部 OK → `router.push('/')`
  - 缺失 → `router.push('/setup-wizard')`
- [ ] DOD：dev:desktop 启动直接命中 setup-check，根据本机状态分流

### 2.5 Setup Wizard - Step 1 Whisper（Day 6-7）

- [ ] **2.5.a** `app/pages/setup-wizard.vue`（新增，含 3 步状态机）
- [ ] **2.5.b** Step 1 UI（v5 § 5.7 草图）：
  - 5 档模型 radio，base 默认选中
  - "Recommended" badge（i18n）
  - 扫描结果显示（"🔗 已存在于 .../models/"）
  - 三选项：复制 / 软链接 / 忽略
  - "添加扫描路径..." 按钮
  - HF 镜像切换 toggle
  - 下载进度（百分比 + 字节 + 估算剩余）
- [ ] **2.5.c** 后台启动下载（决策 26 部分并行），允许用户进入 Step 2
- [ ] DOD：选 base + 软链接 → 立即完成；选 base + 下载 → 下载到 userData/models/whisper/

### 2.6 Setup Wizard - Step 2 Ollama（Day 8）

- [ ] **2.6.a** `desktop/ollamaDetector.ts`（v5 § 5.3）
- [ ] **2.6.b** Step 2 UI：
  - "✓ Ollama running" / "⚠️ Ollama 未检测到"
  - "前往 ollama.com" 按钮 → `shell.openExternal`
  - "我已安装" 按钮 → 轮询 probe 5 秒一次直到 running
- [ ] DOD：Ollama 未装时点击 "前往" 打开浏览器；装好回来点 "我已安装" 能识别

### 2.7 Setup Wizard - Step 3 Qwen（决策 35，Day 9-10）

- [ ] **2.7.a** `desktop/modelManager/qwen.ts`（v5 § 5.4）
- [ ] **2.7.b** Step 3 UI：
  - 列 3b/7b/14b
  - 已装的旁标 ✓
  - 默认选已装的（或都没装则 7b）
- [ ] **2.7.c** 下载流程：`POST /api/pull` 解析 NDJSON 进度
- [ ] DOD：dev 机 `ollama pull qwen2.5:14b` 后开 wizard，14b 旁有 ✓ 且默认选中

### 2.8 Setup Wizard - 完成处理（Day 11）

- [ ] **2.8.a** 全部完成 → `router.push('/')` 主界面
- [ ] **2.8.b** 用户跳过某步 → 主界面顶部 banner 提示"X 未配置"
- [ ] DOD：完整向导能从空白机器跑到主界面

### Phase 2 里程碑

- [ ] 全新 macOS 机器（删了 ~/.subcast/、~/.ollama/、Subcast.app）→ 装 .dmg → 启动 → Setup Wizard 跑完三步 → 进主界面 → 拖入视频 → 转写成功
- [ ] 已装 Ollama 的机器：wizard Step 2 自动跳过；Step 3 默认选已装的 Qwen
- [ ] 已装 Whisper base 的机器（如 ~/whisper.cpp/models/）：Step 1 显示"已存在"，可选软链接
- [ ] 磁盘空间不足时下载按钮禁用，有清晰错误提示

---

## Phase 3 — 桌面增强 + 启动恢复（1 周）

### 3.1 系统托盘（决策 11 + 29，Day 1-2）

- [ ] **3.1.a** `desktop/trayMenu.ts`
- [ ] **3.1.b** 托盘图标多分辨率（22×22 macOS / 16×16 + 32×32 Windows）
- [ ] **3.1.c** 关闭窗口拦截 → `win.hide()` + `app.dock.hide()` (macOS)
- [ ] **3.1.d** Cmd+Q / Ctrl+Q / 托盘 Quit 标记 `isQuitting = true` 走真退出
- [ ] DOD：点 × 隐藏到托盘 + 任务继续跑 + 点托盘恢复

### 3.2 应用菜单（macOS 独有，决策 29，Day 3）

- [ ] **3.2.a** `desktop/menu.ts`
  - macOS：App menu (auto) + Help menu (custom)
  - Windows：`Menu.setApplicationMenu(null)`
- [ ] **3.2.b** Help 菜单 items：Documentation / Report Issue / Export Diagnostics / Check for Updates
- [ ] DOD：macOS 顶部菜单条只有 Subcast + Help；Windows 主窗口无顶部菜单条

### 3.3 启动恢复 plugin（决策 21，Day 4）

- [ ] **3.3.a** `server/plugins/02.recover-zombie-tasks.ts`（v5 § 6.10）
- [ ] **3.3.b** `server/utils/queue.ts` 加 `transcribeQueue.cancelAll()`、`translateQueue.cancelAll()`
- [ ] **3.3.c** `server/utils/insightTasks.ts` 加 `abortAllInsightTasks()`
- [ ] **3.3.d** `desktop/main.ts` `app.on('before-quit')` 调上面三个
- [ ] **3.3.e** 主界面 / 队列页：对 Translate/Insight `failed` 行加 "[重试] [忽略]" UI
- [ ] DOD：dev 启 transcribe → 强杀进程 → 重启 → transcribe 自动从断点继续；translate 标记 failed + UI 出现重试按钮

### 3.4 About 对话框（决策 30，Day 5）

- [ ] **3.4.a** `app/pages/about.vue`（新增）
- [ ] **3.4.b** 主进程 `Menu.buildFromTemplate` 里 "About Subcast" → 新窗口加载 `/about`
- [ ] **3.4.c** About 内容：v5 § 6.16 草图
- [ ] DOD：菜单点 About 弹专门窗口（不阻塞主窗口）；三个按钮跳转 GitHub 正确链接

### 3.5 Export Diagnostics（决策 8，Day 6）

- [ ] **3.5.a** `desktop/diagnostics.ts`
  - 收集近 7 天 `userData/logs/*.jsonl`
  - 加 `system.json`（OS 版本、Subcast 版本、硬件简介）
  - 用 `archiver` 打包 zip
  - `dialog.showSaveDialog` 让用户选保存位置
- [ ] **3.5.b** 文件名格式：`subcast-diagnostics-YYYYMMDD-HHmmss.zip`
- [ ] **3.5.c** Help 菜单 + 托盘菜单都接入
- [ ] DOD：点 "Export Diagnostics..." 弹保存对话框；产出的 zip 解压能看到日志 + system.json

### 3.6 拖放文件（Day 7）

- [ ] **3.6.a** preload 暴露 `subcast.onFileDrop(callback)`
- [ ] **3.6.b** 主窗口 `dragenter` / `drop` 监听
  - macOS：`app.on('open-file')` 也接入同一回调
- [ ] **3.6.c** Renderer 收到回调 → 触发上传流程
- [ ] DOD：拖 .mp4 到主窗口能自动开始上传 + 转写

### Phase 3 里程碑

- [ ] 点 × → 窗口消失，托盘图标仍在；点托盘 "Show Window" → 窗口恢复，主任务继续
- [ ] Cmd+Q / 托盘 Quit → 真退出，cancelAll 调用，所有 running 任务标记取消
- [ ] 重启后 transcribe 自动恢复；translate / insight 标记 failed 并显示重试按钮
- [ ] About 对话框能弹，按钮工作
- [ ] Export Diagnostics 产出有效 zip
- [ ] 拖文件 + macOS Dock 拖文件 + Windows "用 Subcast 打开" 三种入口都能用

---

## Phase 4 — 签名 + 更新策略（1 周）

### 4.1 Windows electron-updater（Day 1-2）

- [ ] **4.1.a** `pnpm add electron-updater`
- [ ] **4.1.b** `electron-builder.config.json5` 加 `publish: { provider: 'github', owner: 'twoer', repo: 'subcast' }`
- [ ] **4.1.c** `desktop/updater.ts` Windows 分支：
  ```ts
  if (process.platform === 'win32') {
    autoUpdater.checkForUpdatesAndNotify();
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 6 * 60 * 60 * 1000);
  }
  ```
- [ ] DOD：手动发 v0.1.0 + v0.1.1 到 GitHub Releases → Win 装好 v0.1.0 → 启动后能自动更新到 v0.1.1（差分包）

### 4.2 macOS manualUpdater（决策 9，Day 3）

- [ ] **4.2.a** `desktop/manualUpdater.ts`（v5 § 6.4）
- [ ] **4.2.b** 集成到 App 菜单 + 托盘菜单 "Check for Updates..."
- [ ] **4.2.c** 启动后 5 秒静默检查一次（silent=true）
- [ ] DOD：macOS 启动 → 5 秒后如有新版本弹窗显示 v0.x.y → 点 "打开下载页" → 浏览器打开 GitHub Releases 对应版本

### 4.3 NSIS uninstaller 自定义（决策 24，Day 4）

- [ ] **4.3.a** `build/uninstaller.nsh`：
  ```nsis
  !macro customUnInit
    MessageBox MB_YESNO "是否同时删除您的视频缓存、字幕模型等数据？$\n默认保留" /SD IDNO IDYES delete_userdata IDNO skip_delete
    delete_userdata:
      RMDir /r "$APPDATA\Subcast"
    skip_delete:
  !macroend
  ```
- [ ] DOD：Windows 卸载流程弹窗"是否删数据"默认否；选是会删除 `%APPDATA%/Subcast/`

### 4.4 启动失败 dialog 完整化（Day 5）

- [ ] **4.4.a** `desktop/main.ts` startNitro 包 try/catch（v5 § 6.12）
- [ ] **4.4.b** 失败时 dialog 三按钮：[打开日志] / [报告问题] / [退出]
- [ ] DOD：故意制造启动失败（如改 SUBCAST_HOME 到只读路径）→ 弹友好对话框

### Phase 4 里程碑

- [ ] Windows：v0.1.0 安装 → 升 v0.1.1 自动差分更新（patch 大小 < 50MB）
- [ ] macOS：菜单 Check for Updates 能弹新版本提示，点击打开 GitHub Releases
- [ ] Windows 卸载流程弹窗 "是否删数据" 选项工作
- [ ] Nitro 启动失败弹友好对话框（不黑屏）

---

## Phase 5 — i18n + 测试 + 发布（1-1.5 周）

### 5.1 i18n 完整覆盖（决策 32，Day 1-2）

- [ ] **5.1.a** 整理 `desktop.*` namespace 所有 keys 清单（v5 § 6.19 给的分类）
- [ ] **5.1.b** `i18n/locales/en.json` 加 `desktop.*` 约 50 项
- [ ] **5.1.c** `i18n/locales/zh-CN.json` 同步
- [ ] **5.1.d** Electron 主进程 dialog 文案 i18n：主进程读 `app.getLocale()` 选 zh/en
- [ ] DOD：切系统语言 zh/en，Setup Wizard / 托盘菜单 / dialog 文案都跟着切

### 5.2 README + 截图引导（Day 3-4）

- [ ] **5.2.a** README.md（英文）重写：
  - 顶部 callout（联网提示）
  - 安装步骤截图（macOS 14、macOS 15+、Windows 三套）
  - "SmartScreen 警告处理" 段落
  - "macOS Gatekeeper 警告处理" 段落
  - Export Diagnostics 用法
  - License (AGPL-3.0) 说明
- [ ] **5.2.b** README.zh.md（中文对应）
- [ ] **5.2.c** 应用内 Help 页面 `/help`（新增）镜像 README 关键步骤
- [ ] DOD：README 在 GitHub 上看排版正确；截图清晰

### 5.3 烟雾测试（Day 5-6）

- [ ] **5.3.a** macOS arm64 完整路径：装 → 首启 → 向导跑完 → 拖视频 → 转写 → 翻译 → AI 摘要 → 导出 → 关窗到托盘 → 重新打开 → 卸载 → 验证 userData 残留
- [ ] **5.3.b** Windows x64 完整路径：同上 + SmartScreen 警告处理 + NSIS 卸载弹窗
- [ ] **5.3.c** 模型扫描复用测试（决策 34）
- [ ] **5.3.d** Qwen 已装检测测试（决策 35）
- [ ] **5.3.e** 磁盘空间预检测试（小磁盘 + 大模型）
- [ ] **5.3.f** 网络中断测试（下载中拔网 → 续传 → 校验失败 → 重试）
- [ ] **5.3.g** 多实例锁测试（双击两次只起一个）
- [ ] **5.3.h** 启动失败测试（故意制造错误）
- [ ] DOD：所有测试用例通过

### 5.4 性能基线测量（Day 7）

- [ ] **5.4.a** 冷启动时间（终止所有 Subcast 后双击 → 主界面可交互）
  - 目标 < 3s on M1+ / 8GB
- [ ] **5.4.b** 稳态主进程内存
  - 目标 < 300MB
- [ ] **5.4.c** 第一条 cue 出现延迟（点开始转写 → 首个 cue 渲染）
  - 目标 < 5s (base 模型)
- [ ] **5.4.d** 记录基线 → `docs/performance-baseline.md`
- [ ] DOD：基线文档存在，所有指标 ≤ 目标

### 5.5 发布 v0.1.0（Day 8）

- [ ] **5.5.a** `git tag v0.1.0 && git push --tags`
- [ ] **5.5.b** CI release workflow 跑通（macOS + Windows 各产出一个 artifact）
- [ ] **5.5.c** 创建 GitHub Release，附 release notes：
  - 安装步骤（链 README 截图）
  - 已知 limitations（macOS 自动更新需手动检查）
  - 系统要求
  - License 链接
- [ ] **5.5.d** README 顶部加 Download badge
- [ ] DOD：陌生人能从 GitHub Release 下载 → 装 → 跑通转写一个视频

### Phase 5 里程碑

- [ ] v0.1.0 发布在 GitHub Releases
- [ ] README 含完整安装步骤截图
- [ ] 应用内 Help 页面镜像 README
- [ ] 性能基线达标
- [ ] 所有烟雾测试通过

---

## 附录 A：每周时间分配建议（假设全职）

| 周 | 任务 | 工作量 |
|---|---|---|
| W1 | 1.1 - 1.6 (Electron 骨架 + Nitro 内嵌 + 鉴权) | 5 天 |
| W2 | 1.7 - 1.10 (better-sqlite3 / whisper-cli CI / ffmpeg / 路径) | 5 天 |
| W3 | 1.11 - 1.14 (icon / electron-builder / 单实例锁 / Win 自签) | 5 天 |
| W4 | 2.1 - 2.4 (下载器 / 扫描 / 磁盘预检 / setup-check) | 5 天 |
| W5 | 2.5 - 2.8 (Wizard 三步) | 5 天 |
| W6 | 3.1 - 3.6 (托盘 / 菜单 / 启动恢复 / About / Diagnostics / 拖放) | 7 天 |
| W7 | 4.1 - 4.4 (Win updater / macOS manualUpdater / NSIS / 启动失败) | 5 天 |
| W8 | 5.1 - 5.5 (i18n / README / 烟测 / 性能 / 发布) | 7 天 |

**总计：44 工作日 ≈ 9 周** (含 1 周 buffer)

team 没碰过 Electron 的话再 +2 周。

---

## 附录 B：开工前必须准备好的清单

操作要求：

- [ ] Apple ID 注册（即使不签名也建议有，App Store 调试日志好查）
- [ ] GitHub 仓库已创建 `twoer/subcast` 并 push 当前 main 分支
- [ ] 一台 Windows 11 测试机（VM 也行，需要 PowerShell + signtool）
- [ ] 一台 macOS 15+ arm64 测试机
- [ ] GitHub Personal Access Token (gh CLI 用，发 Release 用)

仓库状态要求（在写一行 Electron 代码前确认）：

- [ ] main 分支已经合并所有当前 player UX + AI Insights 功能（已完成）
- [ ] 测试都通过：`pnpm test` (59/59)
- [ ] Lint 干净：`pnpm lint`
- [ ] typecheck 干净

---

## 附录 C：关键风险预案

| 风险 | 触发条件 | 应对 |
|---|---|---|
| better-sqlite3 在 win-x64 不 rebuild 成功 | Phase 1.7 跑 electron-rebuild 报错 | 备选：换 napi-rs based 的 `node-sqlite3` 或预 prebuild |
| whisper.cpp CI 跑 30 分钟以上 | Phase 1.8 CI 反复超时 | 加 cache: `actions/cache@v4` 缓存 whisper.cpp 编译产物 |
| Windows self-signed cert 在 Win 11 24H2+ 被屏蔽更严 | Phase 1.14 后发现 SmartScreen 完全不让点 More info | 改路径：升级到 OV 证书 (~$200/年) |
| Ollama 5GB Qwen 下载 8 分钟以上用户失去耐心 | Phase 2.7 用户反馈 | 默认推荐 3b (1.9GB)，UI 加 "需要更高质量？换 7b" 提示 |
| macOS 15+ Gatekeeper 路径在某些 minor 版本下又变了 | Phase 1 后发现新系统装不上 | README 加版本对照表 + 实时维护 |
| Hugging Face 完全被墙（小概率）| Phase 2 国内用户都跑 hf-mirror | 加第二镜像（如 mirror.sjtu.edu.cn） |

---

## 配套文档

- 设计文档（决策的"为什么"）：[docs/desktop-packaging.md](./desktop-packaging.md)
- 性能基线：`docs/performance-baseline.md`（Phase 5.4 产出）
- 用户使用说明：[README.md](../README.md) / [README.zh.md](../README.zh.md)
