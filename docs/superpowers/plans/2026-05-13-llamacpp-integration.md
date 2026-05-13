# Subcast 0.2 — llama.cpp Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the external Ollama dependency with a bundled `llama-server` sidecar so AI Insights / 翻译 work out of the box. AI features remain 100% local; users no longer install Ollama.

**Architecture:** New `LLMBackend` interface in `server/utils/llmClient.ts` is the single abstraction the business code consumes. Current implementation `LlamaServerBackend` does HTTP to a `llama-server` child process managed by `desktop/llmServer.ts` (lazy spawn, idle shutdown). Models are standard `.gguf` files in `<userData>/models/llm/`, downloaded via the same `downloader.ts` we already use for Whisper.

**Tech Stack:** llama.cpp (`llama-server` binary from upstream GitHub releases); Qwen 2.5 Q4_K_M GGUF models from HuggingFace / hf-mirror / ModelScope; existing Subcast stack (Nuxt 4 + Vue 3 + Electron 36 + better-sqlite3); zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-05-13-llamacpp-integration-design.md`

---

## File Structure

**New (CI / scripts):**
- `.github/workflows/build-llama-server.yml` — Build/sign llama-server for macOS arm64 + Windows x64
- `scripts/fetch-llama-server.mjs` — Build-host helper, pulls binary from a CI release artifact or GitHub releases
- `scripts/fetch-qwen-gguf.mjs` — Optional dev helper (not used by build pipeline; for local smoke-testing)

**New (desktop main):**
- `desktop/orphanCleanup.ts` — Generic orphan-sidecar killer used at boot
- `desktop/modelManager/llmConfig.ts` — Qwen 三档 catalog + mirror table + tier→model mapping
- `desktop/modelManager/llmScan.ts` — Scan LM Studio / Jan / `~/.cache/llama.cpp` for existing GGUF
- `desktop/modelManager/llmInstall.ts` — symlink / copy / download dispatcher
- `desktop/__tests__/orphanCleanup.test.ts`
- `desktop/modelManager/__tests__/llmConfig.test.ts`
- `desktop/modelManager/__tests__/llmScan.test.ts`
- `desktop/modelManager/__tests__/llmInstall.test.ts`

**New (server):**
- `server/utils/llmServer.ts` — llama-server lifecycle: spawn / wait-ready / idle-shutdown. Lives in Nitro (not desktop/) so `LlamaServerBackend.chat()` can call `.ensure()` directly; Electron main shuts it down via the existing `/api/desktop/shutdown` POST
- `server/utils/__tests__/llmServer.test.ts`
- `server/utils/llmClient.ts` — `LLMBackend` interface + `LlamaServerBackend` impl
- `server/utils/__tests__/llmClient.test.ts`
- `server/api/desktop/llm/status.get.ts`
- `server/api/desktop/llm/install.post.ts`
- `server/api/desktop/llm/install.get.ts`
- `server/api/desktop/llm/install.delete.ts`
- `server/api/desktop/llm/[model].delete.ts`
- `server/utils/llmInstallTask.ts` — Install task state (mirrors `whisperInstallTask.ts`)

**Modified:**
- `server/utils/settings.ts` — Field rename `ollamaModel` → `llmModel`; migration shim
- `server/utils/insightTasks.ts` — Replace Ollama HTTP calls with `llmClient`
- `server/utils/insights.ts` — Same
- `server/utils/__tests__/insights.test.ts` — Mock `LLMBackend` instead of Ollama
- `app/pages/setup-wizard.vue` — Step 3 → step 2; delete old step 2 (Ollama detect); scan UI; migration-hint reader
- `app/pages/settings.vue` — Models tab Ollama section → LLM section
- `app/components/AppHeader.vue` — chip readiness `ollamaReady` → `llmReady`
- `app/composables/useActiveModels.ts` — Internal field rename
- `i18n/locales/{en,zh-CN}.json` — Add LLM strings, remove Ollama / qwen blocks
- `electron-builder.config.cjs` — extraResources adds llama-server
- `desktop/binaryCheck.ts` — REQUIRED_BINARIES adds `'llama-server'`
- `desktop/main.ts` — before-quit SIGTERMs llama-server
- `docs/smoke-tests.md` — LLM section
- `package.json` — version bump to 0.2.0, `test:llm` script
- `README.md` / `README.zh.md` — Remove Ollama installation prereq

**Deleted:**
- `desktop/ollamaDetector.ts`
- `server/api/desktop/ollama/status.get.ts`
- `server/api/desktop/ollama/fix-key.post.ts`
- `server/api/desktop/ollama/[name].delete.ts`
- `server/api/desktop/qwen/pull.get.ts`
- `server/api/desktop/qwen/pull.post.ts`
- `server/api/desktop/qwen/pull.delete.ts`
- `server/utils/qwenPullTask.ts`
- `desktop/modelManager/qwen.ts`
- `desktop/modelManager/__tests__/qwen.test.ts`

---

## Conventions

- Tests in `<package>/__tests__/`, picked up by `vitest.config.ts`.
- Server errors via `createError({ statusCode, statusMessage, data? })`.
- All h3 helpers explicitly imported from `'h3'`.
- One commit per task. Don't squash mid-task; if a task fails partway, fix forward.
- Subcast project policy: no decorative comments, only WHY-comments for non-obvious invariants.
- TypeScript strict; never `any` without justification.

---

## Phase 0 — CI Pipeline for llama-server Binary

### Task 0.1: Add llama-server build workflow

**Files:**
- Create: `.github/workflows/build-llama-server.yml`

- [ ] **Step 1: Add the workflow file**

```yaml
name: build-llama-server

on:
  push:
    paths: [.github/workflows/build-llama-server.yml]
  workflow_dispatch:

env:
  LLAMA_CPP_VERSION: b4524  # pin a specific upstream tag; bump deliberately

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-14
            arch: arm64
            cmake_flags: -DGGML_METAL=ON -DLLAMA_CURL=OFF
            artifact_path: build/bin/llama-server
          - os: windows-latest
            arch: x64
            cmake_flags: -DLLAMA_CURL=OFF
            artifact_path: build/bin/Release/llama-server.exe
    runs-on: ${{ matrix.os }}
    steps:
      - name: Checkout llama.cpp
        uses: actions/checkout@v4
        with:
          repository: ggml-org/llama.cpp
          ref: ${{ env.LLAMA_CPP_VERSION }}
      - name: Build
        run: |
          mkdir build && cd build
          cmake .. ${{ matrix.cmake_flags }}
          cmake --build . --target llama-server --config Release -j
          ls -lh ${{ matrix.artifact_path }}
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: llama-server-${{ matrix.os }}-${{ matrix.arch }}
          path: ${{ matrix.artifact_path }}
          retention-days: 90
```

- [ ] **Step 2: Trigger the workflow once and verify both artifacts are produced**

Run via the GitHub UI (`Actions` → `build-llama-server` → `Run workflow`). Expected: two artifacts available for download, ~10-20 MB each.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-llama-server.yml
git commit -m "ci: build llama-server for macOS arm64 + Windows x64"
```

### Task 0.2: Add scripts/fetch-llama-server.mjs

**Files:**
- Create: `scripts/fetch-llama-server.mjs`

- [ ] **Step 1: Write the script**

Mirror the shape of `scripts/fetch-ggml-base.mjs`. Reads `LLAMA_CPP_VERSION` from the CI workflow, downloads the per-platform artifact from a configured GH Releases URL (we'll publish artifacts there manually for now; later this becomes the build:desktop:* pre-step).

```js
#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Fetch llama-server binary from a Subcast-mirrored GitHub Release into
 * binaries/<plat>-<arch>/llama-server[.exe] so electron-builder can
 * bundle it via extraResources.
 *
 * Versions are pinned via the LLAMA_CPP_VERSION constant — bump when
 * intentionally upgrading. The script is idempotent: it skips download
 * if a binary already exists and is the expected size.
 */

import { createWriteStream, existsSync, statSync, chmodSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';

const LLAMA_CPP_VERSION = 'b4524';
const REPO = process.cwd();

// Platform-specific URLs. Replace with your own Subcast-mirrored
// release once you publish, or `gh release download` directly.
const URLS = {
  'darwin-arm64': `https://github.com/twoer/subcast-binaries/releases/download/${LLAMA_CPP_VERSION}/llama-server-macos-arm64`,
  'win32-x64': `https://github.com/twoer/subcast-binaries/releases/download/${LLAMA_CPP_VERSION}/llama-server-windows-x64.exe`,
};
const MIN_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = 50 * 1024 * 1024;

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const url = URLS[target];
if (!url) {
  console.error(`[fetch-llama-server] no URL for ${target}; supported: ${Object.keys(URLS).join(', ')}`);
  process.exit(1);
}

const ext = target.startsWith('win32') ? '.exe' : '';
const dest = join(REPO, 'binaries', target, `llama-server${ext}`);

if (existsSync(dest) && !process.argv.includes('--force')) {
  const size = statSync(dest).size;
  if (size >= MIN_BYTES && size <= MAX_BYTES) {
    console.log(`[fetch-llama-server] already present (${(size / 1024 / 1024).toFixed(1)} MB) at ${dest} — skipping.`);
    process.exit(0);
  }
}

await mkdir(dirname(dest), { recursive: true });
const tmp = `${dest}.partial`;
await rm(tmp, { force: true });

console.log(`[fetch-llama-server] downloading from ${url}`);
const res = await fetch(url);
if (!res.ok || !res.body) {
  console.error(`[fetch-llama-server] HTTP ${res.status} ${res.statusText}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));

const size = statSync(tmp).size;
if (size < MIN_BYTES || size > MAX_BYTES) {
  console.error(`[fetch-llama-server] downloaded size ${size}B outside [${MIN_BYTES}, ${MAX_BYTES}] — discarding.`);
  await rm(tmp);
  process.exit(1);
}

await rename(tmp, dest);
chmodSync(dest, 0o755);
console.log(`[fetch-llama-server] saved to ${dest}`);
```

- [ ] **Step 2: Run it locally to fetch the macOS arm64 binary**

Run: `node scripts/fetch-llama-server.mjs`
Expected: `binaries/darwin-arm64/llama-server` exists, ~10-20 MB, executable.

(Note: until you publish the GitHub Release, this will 404. Skip this step or temporarily point URLs at the CI artifact download path you got from Task 0.1. The plan assumes you'll publish a Subcast-binaries release once.)

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-llama-server.mjs
git commit -m "chore(build): add fetch-llama-server.mjs helper for build-host"
```

---

## Phase 1 — LLM Backend Abstraction + Sidecar Lifecycle

### Task 1.1: Define LLMBackend interface + skeleton

**Files:**
- Create: `server/utils/llmClient.ts`
- Create: `server/utils/__tests__/llmClient.test.ts`

- [ ] **Step 1: Write the interface file with no implementation yet**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Backend-agnostic LLM client. Business code (insights, translation)
 * only ever depends on `LLMBackend` — the active implementation is
 * selected at module load via `createLLMBackend()`. This makes the
 * future MAS / inline / cloud BYOK migrations a single-file swap.
 *
 * Wire format mirrors OpenAI's Chat Completions API, which llama-server
 * speaks natively and which every other backend can adapt to.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChatOptions {
  messages: LLMMessage[];
  /** Hard upper bound on generated tokens; default 2048. */
  maxTokens?: number;
  /** Sampling temperature; default 0.2 for analytical tasks. */
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMChunk {
  /** Token delta appended this tick (may be empty). */
  delta: string;
  /** Set on the final chunk only. */
  finishReason?: 'stop' | 'length' | 'cancel';
}

export interface LLMBackend {
  chat(opts: LLMChatOptions): Promise<string>;
  chatStream(opts: LLMChatOptions): AsyncIterable<LLMChunk>;
}

// Implementations live in their own files to keep this module
// type-only-ish. createLLMBackend is the only impl-aware export.
import { LlamaServerBackend } from './llmBackendLlamaServer';

export function createLLMBackend(): LLMBackend {
  if (process.env.SUBCAST_BUILD_TARGET === 'mas') {
    throw new Error('mas backend not yet implemented');
  }
  return new LlamaServerBackend();
}

let cached: LLMBackend | null = null;
export function llmBackend(): LLMBackend {
  if (cached === null) cached = createLLMBackend();
  return cached;
}
```

- [ ] **Step 2: Write a smoke test that asserts the interface shape**

```ts
import { describe, it, expect } from 'vitest';
import type { LLMBackend, LLMChatOptions } from '../llmClient';

describe('LLMBackend', () => {
  it('matches the documented interface', () => {
    const stub: LLMBackend = {
      async chat(opts: LLMChatOptions) {
        return opts.messages.map((m) => m.content).join('|');
      },
      // eslint-disable-next-line require-yield
      async *chatStream(_opts) {
        return;
      },
    };
    expect(typeof stub.chat).toBe('function');
    expect(typeof stub.chatStream).toBe('function');
  });
});
```

- [ ] **Step 3: Run test — expect file-not-found because LlamaServerBackend doesn't exist yet**

Run: `pnpm vitest --run server/utils/__tests__/llmClient.test.ts`
Expected: fails resolving `./llmBackendLlamaServer`.

- [ ] **Step 4: Create empty `server/utils/llmBackendLlamaServer.ts` stub so the import resolves**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import type { LLMBackend, LLMChatOptions, LLMChunk } from './llmClient';

export class LlamaServerBackend implements LLMBackend {
  chat(_opts: LLMChatOptions): Promise<string> {
    throw new Error('not yet implemented');
  }
  // eslint-disable-next-line require-yield
  async *chatStream(_opts: LLMChatOptions): AsyncIterable<LLMChunk> {
    throw new Error('not yet implemented');
  }
}
```

- [ ] **Step 5: Run test, expect pass**

Run: `pnpm vitest --run server/utils/__tests__/llmClient.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add server/utils/llmClient.ts server/utils/llmBackendLlamaServer.ts server/utils/__tests__/llmClient.test.ts
git commit -m "feat(llm): introduce LLMBackend abstraction"
```

### Task 1.2: llmServer.ts state machine + lazy spawn

**Files:**
- Create: `server/utils/llmServer.ts`
- Create: `server/utils/__tests__/llmServer.test.ts`

> Rationale: lives in Nitro (not `desktop/`) so `LlamaServerBackend.chat()` (also Nitro) can call `.ensure()` via in-process import. Electron main shuts it down via the existing `/api/desktop/shutdown` POST, which now also calls `llmServer.dispose()`.

- [ ] **Step 1: Write the test for the state machine first**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LlmServer } from '../llmServer';

describe('LlmServer state machine', () => {
  let server: LlmServer;
  beforeEach(() => {
    server = new LlmServer({ idleShutdownMs: 100, spawnFn: vi.fn() });
  });
  afterEach(() => server.dispose());

  it('starts in idle', () => {
    expect(server.state).toBe('idle');
  });

  it('transitions idle → starting → running on ensure()', async () => {
    const fakeProc = { pid: 1234, kill: vi.fn(), on: vi.fn() };
    (server as unknown as { spawnFn: () => unknown }).spawnFn = vi.fn(() => ({
      proc: fakeProc,
      port: 51302,
    }));
    const ready = server.ensure();
    expect(server.state).toBe('starting');
    await ready;
    expect(server.state).toBe('running');
  });

  it('schedules shutdown after idle window with no requests', async () => {
    // ... uses fake timers + spawnFn stub
  });
});
```

- [ ] **Step 2: Run the test, expect file-not-found / class-not-defined**

Run: `pnpm vitest --run server/utils/__tests__/llmServer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `desktop/llmServer.ts` minimum to pass**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { spawn, type ChildProcess } from 'node:child_process';

export type LlmServerState = 'idle' | 'starting' | 'running' | 'stopping';

export interface SpawnResult {
  proc: ChildProcess;
  port: number;
}

export interface LlmServerOptions {
  binaryPath?: string;
  modelPath?: string;
  preferredPort?: number;
  idleShutdownMs?: number;
  /** Test seam — defaults to real spawn. */
  spawnFn?: () => Promise<SpawnResult> | SpawnResult;
}

/**
 * Lifecycle owner for the llama-server sidecar. Single instance per
 * Subcast process. `ensure()` is the only method consumers call — it
 * returns when a server is ready to receive requests, spawning if
 * needed and resetting the idle timer.
 */
export class LlmServer {
  private _state: LlmServerState = 'idle';
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private opts: LlmServerOptions;
  private readyPromise: Promise<void> | null = null;

  constructor(opts: LlmServerOptions = {}) {
    this.opts = { idleShutdownMs: 5 * 60_000, ...opts };
  }

  get state(): LlmServerState {
    return this._state;
  }

  getPort(): number | null {
    return this.port;
  }

  async ensure(): Promise<void> {
    this.armIdleTimer();
    if (this._state === 'running') return;
    if (this._state === 'starting' && this.readyPromise) return this.readyPromise;
    if (this._state === 'stopping') {
      await this.waitForStopped();
    }
    this._state = 'starting';
    this.readyPromise = this.doStart();
    await this.readyPromise;
    this.readyPromise = null;
    this._state = 'running';
  }

  private async doStart(): Promise<void> {
    const result = await (this.opts.spawnFn ?? this.realSpawn)();
    this.proc = result.proc;
    this.port = result.port;
    this.proc.on?.('exit', (code) => {
      this._state = 'idle';
      this.proc = null;
      this.port = null;
      // ... log exit code; if non-zero, increment failure counter
      void code;
    });
  }

  private realSpawn = async (): Promise<SpawnResult> => {
    if (!this.opts.binaryPath || !this.opts.modelPath) {
      throw new Error('binaryPath and modelPath must be set before spawn');
    }
    const proc = spawn(this.opts.binaryPath, [
      '--model', this.opts.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.opts.preferredPort ?? 0),
      '--keep', '-1',
      '--n-gpu-layers', '999',
    ]);
    const port = await this.waitForListeningPort(proc, 10_000);
    return { proc, port };
  };

  private waitForListeningPort(_proc: ChildProcess, _timeoutMs: number): Promise<number> {
    // Parses "HTTP server listening on 127.0.0.1:NNNN" from stdout/stderr.
    // Implemented in Task 1.4.
    return Promise.reject(new Error('waitForListeningPort not yet implemented'));
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), this.opts.idleShutdownMs);
  }

  async stop(): Promise<void> {
    if (this._state !== 'running') return;
    this._state = 'stopping';
    this.proc?.kill('SIGTERM');
    await this.waitForStopped();
  }

  private waitForStopped(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.proc) return resolve();
      this.proc.once('exit', () => resolve());
      setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 5_000);
    });
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    void this.stop();
  }
}
```

- [ ] **Step 4: Run test, expect pass on the basic state-transition tests**

Run: `pnpm vitest --run server/utils/__tests__/llmServer.test.ts`
Expected: 2-3 tests pass (idle / transitions). The "schedules shutdown" test you outlined needs fake-timers; flesh it out in Step 5.

- [ ] **Step 5: Fill out the fake-timer shutdown test and verify**

```ts
it('schedules shutdown after idle window with no requests', async () => {
  vi.useFakeTimers();
  const spawnFn = vi.fn(async () => ({
    proc: { pid: 1, kill: vi.fn(), on: vi.fn(), once: vi.fn((_, cb) => cb()) } as unknown as ChildProcess,
    port: 51302,
  }));
  const srv = new LlmServer({ idleShutdownMs: 1000, spawnFn });
  await srv.ensure();
  expect(srv.state).toBe('running');
  vi.advanceTimersByTime(1000);
  // wait microtask
  await vi.runAllTimersAsync();
  expect(srv.state).toBe('idle');
  vi.useRealTimers();
});
```

Run again, all pass.

- [ ] **Step 6: Commit**

```bash
git add desktop/llmServer.ts server/utils/__tests__/llmServer.test.ts
git commit -m "feat(llm): LlmServer lifecycle state machine with idle shutdown"
```

### Task 1.3: Port-from-stdout parsing

**Files:**
- Modify: `desktop/llmServer.ts`
- Modify: `server/utils/__tests__/llmServer.test.ts`

- [ ] **Step 1: Write a test for `waitForListeningPort` with stubbed stdout**

```ts
it('parses listening port from stdout', async () => {
  const { Readable } = await import('node:stream');
  const fakeStdout = Readable.from([
    'llama server starting\n',
    'HTTP server listening on 127.0.0.1:51302\n',
    'ready\n',
  ]);
  const fakeProc = { stdout: fakeStdout, stderr: Readable.from([]), on: vi.fn() } as unknown as ChildProcess;
  const port = await (new LlmServer() as unknown as { waitForListeningPort: (p: ChildProcess, t: number) => Promise<number> })
    .waitForListeningPort(fakeProc, 2000);
  expect(port).toBe(51302);
});
```

- [ ] **Step 2: Run test, expect "not yet implemented"**

Run: `pnpm vitest --run server/utils/__tests__/llmServer.test.ts -t "parses listening"`
Expected: FAIL.

- [ ] **Step 3: Implement `waitForListeningPort`**

Replace the stub in `desktop/llmServer.ts`:

```ts
private waitForListeningPort(proc: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const re = /listening on (?:[0-9.]+|\[?[0-9a-f:]+\]?):(\d+)/i;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`llama-server did not announce listening port within ${timeoutMs}ms`));
    }, timeoutMs);
    const onChunk = (chunk: Buffer | string) => {
      const m = re.exec(String(chunk));
      if (m) {
        cleanup();
        resolve(Number(m[1]));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off('data', onChunk);
      proc.stderr?.off('data', onChunk);
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
  });
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm vitest --run server/utils/__tests__/llmServer.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add desktop/llmServer.ts server/utils/__tests__/llmServer.test.ts
git commit -m "feat(llm): parse llama-server listening port from stdout"
```

### Task 1.4: LlamaServerBackend HTTP chat() + streaming

**Files:**
- Modify: `server/utils/llmBackendLlamaServer.ts`
- Modify: `server/utils/__tests__/llmClient.test.ts`

- [ ] **Step 1: Write tests for `chat()` and `chatStream()` with mocked fetch**

```ts
import { describe, it, expect, vi } from 'vitest';
import { LlamaServerBackend } from '../llmBackendLlamaServer';

function mockFetchOnce(body: string, { stream = false } = {}) {
  return vi.fn(async () => {
    if (stream) {
      const lines = body.split('\n').filter(Boolean).map((l) => l + '\n\n');
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (const l of lines) controller.enqueue(new TextEncoder().encode(l));
            controller.close();
          },
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      async json() {
        return JSON.parse(body);
      },
    } as unknown as Response;
  });
}

describe('LlamaServerBackend', () => {
  it('chat() returns the assembled message content', async () => {
    process.env.SUBCAST_LLM_PORT = '51302';
    globalThis.fetch = mockFetchOnce(JSON.stringify({
      choices: [{ message: { content: 'hello' } }],
    })) as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    const result = await backend.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toBe('hello');
  });

  it('chatStream() yields deltas from SSE chunks', async () => {
    process.env.SUBCAST_LLM_PORT = '51302';
    globalThis.fetch = mockFetchOnce(
      `data: {"choices":[{"delta":{"content":"hel"}}]}\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n` +
      `data: [DONE]\n`,
      { stream: true },
    ) as unknown as typeof fetch;
    const backend = new LlamaServerBackend();
    const out: string[] = [];
    for await (const chunk of backend.chatStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.delta) out.push(chunk.delta);
    }
    expect(out.join('')).toBe('hello');
  });
});
```

- [ ] **Step 2: Run, expect failures**

Run: `pnpm vitest --run server/utils/__tests__/llmClient.test.ts`
Expected: FAIL (not implemented).

- [ ] **Step 3: Implement `LlamaServerBackend`**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import type { LLMBackend, LLMChatOptions, LLMChunk } from './llmClient';

const DEFAULT_TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_INPUT_TOKEN_MS = 50;

function endpoint(path: string): string {
  const port = process.env.SUBCAST_LLM_PORT;
  if (!port) throw new Error('SUBCAST_LLM_PORT not set — llama-server not ready');
  return `http://127.0.0.1:${port}${path}`;
}

function estimateInputTokens(opts: LLMChatOptions): number {
  // 4 chars/token is the standard approximation for cl100k-style tokenizers.
  return Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

function dynamicTimeoutMs(opts: LLMChatOptions): number {
  return DEFAULT_TIMEOUT_BASE_MS + estimateInputTokens(opts) * TIMEOUT_PER_INPUT_TOKEN_MS;
}

export class LlamaServerBackend implements LLMBackend {
  async chat(opts: LLMChatOptions): Promise<string> {
    const res = await fetch(endpoint('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'subcast-local',
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.2,
        stream: false,
      }),
      signal: opts.signal ?? AbortSignal.timeout(dynamicTimeoutMs(opts)),
    });
    if (!res.ok) throw new Error(`llama-server returned ${res.status}: ${await res.text()}`);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    return body.choices[0]?.message?.content ?? '';
  }

  async *chatStream(opts: LLMChatOptions): AsyncIterable<LLMChunk> {
    const res = await fetch(endpoint('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'subcast-local',
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.2,
        stream: true,
      }),
      signal: opts.signal ?? AbortSignal.timeout(dynamicTimeoutMs(opts)),
    });
    if (!res.ok || !res.body) throw new Error(`llama-server stream returned ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { delta: '', finishReason: 'stop' };
          return;
        }
        try {
          const parsed = JSON.parse(payload) as { choices: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
          const delta = parsed.choices[0]?.delta?.content ?? '';
          const finish = parsed.choices[0]?.finish_reason;
          yield { delta, finishReason: finish === 'length' ? 'length' : undefined };
        } catch {
          // Malformed line; skip.
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `pnpm vitest --run server/utils/__tests__/llmClient.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/llmBackendLlamaServer.ts server/utils/__tests__/llmClient.test.ts
git commit -m "feat(llm): LlamaServerBackend HTTP impl with streaming + dynamic timeout"
```

### Task 1.5: Failure counter + unusable model marking

**Files:**
- Modify: `desktop/llmServer.ts`
- Modify: `server/utils/__tests__/llmServer.test.ts`

- [ ] **Step 1: Add test — 3 consecutive non-zero exits marks model unusable**

```ts
it('marks model unusable after 3 consecutive non-zero exits', async () => {
  let crashCount = 0;
  const spawnFn = vi.fn(async () => {
    crashCount += 1;
    const proc = new EventEmitter() as unknown as ChildProcess & { kill: () => void };
    proc.kill = vi.fn();
    process.nextTick(() => proc.emit('exit', 1));
    return { proc, port: 51302 };
  });
  const srv = new LlmServer({ spawnFn, idleShutdownMs: 60_000 });
  // ... three ensure() attempts; on the fourth, expect throw with "model unusable"
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement failure counting in `LlmServer.doStart`**

In the `exit` handler, track non-zero exits. After 3 in a row without a successful chat, throw `ModelUnusableError` from the next `ensure()`. Successful chat resets the counter.

```ts
// In LlmServer:
private failureCount = 0;
private markUnusable = false;

// In exit handler:
this.proc.on?.('exit', (code) => {
  this._state = 'idle';
  this.proc = null;
  this.port = null;
  if (code !== 0) {
    this.failureCount += 1;
    if (this.failureCount >= 3) this.markUnusable = true;
  }
});

// In ensure() at top:
if (this.markUnusable) throw new Error('MODEL_UNUSABLE');

// Reset counter on successful chat — wire from LlamaServerBackend via a callback or exported `noteSuccess()`.
public noteSuccess(): void { this.failureCount = 0; }
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Commit**

```bash
git add desktop/llmServer.ts server/utils/__tests__/llmServer.test.ts
git commit -m "feat(llm): mark model unusable after 3 consecutive crashes"
```

### Task 1.6: Orphan cleanup at boot

**Files:**
- Create: `desktop/orphanCleanup.ts`
- Create: `desktop/__tests__/orphanCleanup.test.ts`
- Modify: `desktop/main.ts`

- [ ] **Step 1: Write test for `findOrphans()` using mocked `ps`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { findOrphans } from '../orphanCleanup';

describe('findOrphans', () => {
  it('returns processes matching name and parent === 1', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'PID PPID COMMAND\n1234 1 /path/to/llama-server\n5678 999 something-else',
    }));
    const orphans = await findOrphans(['llama-server', 'whisper-cli'], { exec });
    expect(orphans).toEqual([{ pid: 1234, name: 'llama-server' }]);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement `desktop/orphanCleanup.ts`**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Orphan {
  pid: number;
  name: string;
}

export interface FindOrphansOpts {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}

export async function findOrphans(names: readonly string[], opts: FindOrphansOpts = {}): Promise<Orphan[]> {
  const exec = opts.exec
    ? (cmd: string, args: string[]) => opts.exec!(cmd, args)
    : (cmd: string, args: string[]) => execFileAsync(cmd, args);
  // -A all processes, -o specifies columns; PPID 1 = orphaned (re-parented to launchd / init)
  const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  const orphans: Orphan[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const comm = m[3]!.trim();
    if (ppid !== 1) continue;
    const matched = names.find((n) => comm.endsWith(n) || comm.endsWith(n + '.exe'));
    if (matched) orphans.push({ pid, name: matched });
  }
  return orphans;
}

export async function killOrphans(names: readonly string[]): Promise<number> {
  const orphans = await findOrphans(names);
  for (const o of orphans) {
    try {
      process.kill(o.pid, 'SIGTERM');
    } catch {
      // Already gone; ignore.
    }
  }
  return orphans.length;
}
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Call `killOrphans(['llama-server', 'whisper-cli'])` early in `desktop/main.ts bootstrap()`**

Place it right after `app.whenReady()` and before the binary check.

```ts
import { killOrphans } from './orphanCleanup.js';
// ...
async function bootstrap(): Promise<void> {
  await app.whenReady();
  const cleaned = await killOrphans(['llama-server', 'whisper-cli']);
  if (cleaned > 0) console.log(`[subcast] killed ${cleaned} orphan sidecar(s) from prior crash`);
  // ... rest unchanged
}
```

- [ ] **Step 6: Commit**

```bash
git add desktop/orphanCleanup.ts desktop/__tests__/orphanCleanup.test.ts desktop/main.ts
git commit -m "feat(desktop): kill orphan llama-server / whisper-cli at boot"
```

---

## Phase 2 — Model Catalog, Scan, Install

### Task 2.1: Qwen catalog

**Files:**
- Create: `desktop/modelManager/llmConfig.ts`
- Create: `desktop/modelManager/__tests__/llmConfig.test.ts`

- [ ] **Step 1: Test the catalog structure**

```ts
import { describe, it, expect } from 'vitest';
import { LLM_MODELS, llmDownloadUrl, recommendLlmModel } from '../llmConfig';

describe('llmConfig', () => {
  it('exposes 3B / 7B / 14B with monotonic size', () => {
    const ids = ['3b', '7b', '14b'] as const;
    const sizes = ids.map((id) => LLM_MODELS[id].sizeBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('hf-mirror URL contains hf-mirror.com', () => {
    expect(llmDownloadUrl('7b', 'hf-mirror')).toContain('hf-mirror.com');
  });

  it('recommendLlmModel maps tier ranges correctly', () => {
    expect(recommendLlmModel({ totalMemoryGB: 4 })).toBe('3b');
    expect(recommendLlmModel({ totalMemoryGB: 16 })).toBe('7b');
    expect(recommendLlmModel({ totalMemoryGB: 64 })).toBe('14b');
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement `desktop/modelManager/llmConfig.ts`**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */

export type LlmModelId = '3b' | '7b' | '14b';
export type LlmMirror = 'huggingface' | 'hf-mirror' | 'modelscope';

export interface LlmModelInfo {
  filename: string;
  sizeBytes: number;
  /** sha256 left undefined for now; populate at release-time from upstream blob. */
  sha256?: string;
  /** Minimum recommended RAM in GB. */
  minRamGB: number;
}

export const LLM_MODELS: Record<LlmModelId, LlmModelInfo> = {
  '3b':  { filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',  sizeBytes: 1_930_000_000, minRamGB: 8 },
  '7b':  { filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',  sizeBytes: 4_700_000_000, minRamGB: 16 },
  '14b': { filename: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf', sizeBytes: 9_000_000_000, minRamGB: 32 },
};

const MIRROR_PREFIX: Record<LlmMirror, (id: LlmModelId) => string> = {
  huggingface: (id) => `https://huggingface.co/Qwen/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
  'hf-mirror': (id) => `https://hf-mirror.com/Qwen/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/main`,
  modelscope:  (id) => `https://modelscope.cn/models/Qwen/Qwen2.5-${idCase(id)}-Instruct-GGUF/resolve/master`,
};

function idCase(id: LlmModelId): string {
  return id.toUpperCase().replace('B', 'B');
}

export function llmDownloadUrl(id: LlmModelId, mirror: LlmMirror): string {
  return `${MIRROR_PREFIX[mirror](id)}/${LLM_MODELS[id].filename.toLowerCase()}`;
}

export const RECOMMENDED_LLM_MODEL: LlmModelId = '7b';

export interface HardwareHint {
  totalMemoryGB: number;
}

export function recommendLlmModel(hw: HardwareHint): LlmModelId {
  if (hw.totalMemoryGB >= 32) return '14b';
  if (hw.totalMemoryGB >= 16) return '7b';
  return '3b';
}
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Commit**

```bash
git add desktop/modelManager/llmConfig.ts desktop/modelManager/__tests__/llmConfig.test.ts
git commit -m "feat(llm): Qwen 2.5 catalog + tier-based recommendation"
```

### Task 2.2: llmScan — discover existing GGUF on disk

**Files:**
- Create: `desktop/modelManager/llmScan.ts`
- Create: `desktop/modelManager/__tests__/llmScan.test.ts`

Mirror the architecture of `whisperScan.ts` exactly — same `ScanResult` shape, same `defaultRoots()` pattern, just different filename regex + different default paths.

- [ ] **Step 1: Test happy-path scan with a tmp dir**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLlmModels } from '../llmScan';

describe('scanLlmModels', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llmscan-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a Qwen2.5-7B file with plausible size', async () => {
    const subdir = join(dir, 'qwen-models');
    await mkdir(subdir, { recursive: true });
    // 5 GB sparse file to look plausible
    const path = join(subdir, 'Qwen2.5-7B-Instruct-Q4_K_M.gguf');
    await writeFile(path, '');
    // Note: real check stats size — for tests we mock or use a smaller min in MODEL_META override
    const results = await scanLlmModels({ rootPaths: [subdir], minSizeOverride: 0 });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('7b');
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement `desktop/modelManager/llmScan.ts` modeled on `whisperScan.ts`**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LlmModelId } from './llmConfig';
import { LLM_MODELS } from './llmConfig';

const FILENAME_RE = /^Qwen2\.5-(3B|7B|14B)-Instruct-Q4_K_M\.gguf$/i;

export interface LlmScanResult {
  name: LlmModelId;
  path: string;
  source: string;
  sizeBytes: number;
}

export interface LlmScanOptions {
  extraPaths?: string[];
  rootPaths?: string[];
  /** Test seam: lower the minimum size for synthetic GGUFs. */
  minSizeOverride?: number;
}

function defaultRoots(): Array<{ path: string; source: string }> {
  const home = homedir();
  const roots: Array<{ path: string; source: string }> = [];

  const subcastHome = process.env.SUBCAST_HOME;
  if (subcastHome) {
    roots.push({ path: join(subcastHome, 'models', 'llm'), source: 'Subcast' });
  }

  if (process.platform === 'darwin') {
    roots.push({
      path: join(home, 'Library', 'Application Support', 'Subcast', 'models', 'llm'),
      source: 'Subcast (installed)',
    });
  }
  roots.push(
    { path: join(home, '.cache', 'lm-studio', 'models', 'lmstudio-community'), source: 'LM Studio' },
    { path: join(home, '.cache', 'llama.cpp'), source: 'llama.cpp cache' },
    { path: join(home, 'Library', 'Caches', 'jan', 'models'), source: 'Jan' },
    { path: join(home, 'Library', 'Application Support', 'jan', 'data', 'models'), source: 'Jan' },
    { path: join(home, '.subcast', 'models', 'llm'), source: 'Subcast (legacy)' },
  );
  return roots;
}

async function safeReaddirRecursive(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await safeReaddirRecursive(full, depth - 1));
    } else if (e.isFile() && FILENAME_RE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function asModelId(s: string): LlmModelId | null {
  const lower = s.toLowerCase();
  if (lower === '3b' || lower === '7b' || lower === '14b') return lower;
  return null;
}

export async function scanLlmModels(opts: LlmScanOptions = {}): Promise<LlmScanResult[]> {
  const roots = opts.rootPaths
    ? opts.rootPaths.map((p) => ({ path: p, source: p }))
    : defaultRoots();
  const extras = (opts.extraPaths ?? []).map((p) => ({ path: p, source: 'User' }));
  const minSize = opts.minSizeOverride ?? Math.min(...Object.values(LLM_MODELS).map((m) => m.sizeBytes * 0.8));

  const results: LlmScanResult[] = [];
  const seen = new Set<string>();

  for (const root of [...roots, ...extras]) {
    const files = await safeReaddirRecursive(root.path, 4);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      let size: number;
      try {
        const st = await stat(file);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      if (size < minSize) continue;
      const m = FILENAME_RE.exec(file.split('/').pop() ?? '');
      const id = m ? asModelId(m[1]!) : null;
      if (!id) continue;
      const expected = LLM_MODELS[id].sizeBytes;
      if (size < expected * 0.7 || size > expected * 1.3) continue;
      results.push({ name: id, path: file, source: root.source, sizeBytes: size });
    }
  }
  return results;
}
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Commit**

```bash
git add desktop/modelManager/llmScan.ts desktop/modelManager/__tests__/llmScan.test.ts
git commit -m "feat(llm): scan LM Studio / Jan / llama.cpp cache for existing GGUF"
```

### Task 2.3: llmInstall — symlink / copy / download

**Files:**
- Create: `desktop/modelManager/llmInstall.ts`
- Create: `desktop/modelManager/__tests__/llmInstall.test.ts`

Mirror `whisperInstall.ts`. Three exported functions: `installLlmBySymlink`, `installLlmByCopy`, `installLlmByDownload`.

- [ ] **Step 1: Tests for symlink + copy in a tmp dir**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLlmBySymlink, installLlmByCopy } from '../llmInstall';

describe('llmInstall', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llminstall-'));
    process.env.SUBCAST_HOME = dir;
    process.env.SUBCAST_DESKTOP = 'true';
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SUBCAST_HOME;
    delete process.env.SUBCAST_DESKTOP;
  });

  it('symlinks src to canonical install path', async () => {
    const src = join(dir, 'fake.gguf');
    await writeFile(src, 'X');
    const { destPath } = await installLlmBySymlink(src, '7b');
    const st = await lstat(destPath);
    expect(st.isSymbolicLink()).toBe(true);
  });

  it('copy makes a real file', async () => {
    const src = join(dir, 'fake.gguf');
    await writeFile(src, 'XYZ');
    const { destPath } = await installLlmByCopy(src, '3b');
    const content = await readFile(destPath, 'utf8');
    expect(content).toBe('XYZ');
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement `desktop/modelManager/llmInstall.ts`**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { copyFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { downloadFile, type DownloadProgress } from './downloader';
import type { LlmMirror, LlmModelId } from './llmConfig';
import { LLM_MODELS, llmDownloadUrl } from './llmConfig';

function llmModelsDir(): string {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw new Error('llm install is desktop-only');
  }
  const home = process.env.SUBCAST_HOME;
  if (!home) throw new Error('SUBCAST_HOME not set');
  return join(home, 'models', 'llm');
}

export function llmModelPath(id: LlmModelId): string {
  return join(llmModelsDir(), LLM_MODELS[id].filename);
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function installLlmBySymlink(srcPath: string, id: LlmModelId): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  if (await fileExists(destPath)) await rm(destPath, { force: true });
  await symlink(srcPath, destPath);
  return { destPath };
}

export async function installLlmByCopy(srcPath: string, id: LlmModelId): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  if (await fileExists(destPath)) await rm(destPath, { force: true });
  await copyFile(srcPath, destPath);
  return { destPath };
}

export async function installLlmByDownload(
  id: LlmModelId,
  mirror: LlmMirror,
  options: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  await downloadFile({
    url: llmDownloadUrl(id, mirror),
    destPath,
    expectedSha256: LLM_MODELS[id].sha256,
    onProgress: options.onProgress,
    signal: options.signal,
  });
  return { destPath };
}
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Commit**

```bash
git add desktop/modelManager/llmInstall.ts desktop/modelManager/__tests__/llmInstall.test.ts
git commit -m "feat(llm): symlink / copy / download install methods"
```

### Task 2.4: LLM install task + API endpoints

**Files:**
- Create: `server/utils/llmInstallTask.ts`
- Create: `server/api/desktop/llm/install.post.ts`
- Create: `server/api/desktop/llm/install.get.ts`
- Create: `server/api/desktop/llm/install.delete.ts`
- Create: `server/api/desktop/llm/status.get.ts`
- Create: `server/api/desktop/llm/[model].delete.ts`

Mirror `server/utils/whisperInstallTask.ts` + the whisper install endpoints — same shape, different filenames.

- [ ] **Step 1: Copy `whisperInstallTask.ts` → `llmInstallTask.ts`, rename types**

Read `whisperInstallTask.ts`, save a parallel `llmInstallTask.ts` with: `WhisperModelName` → `LlmModelId`; `WhisperMirror` → `LlmMirror`; `installBy{Symlink,Copy,Download}` calls swapped to the `installLlmBy{...}` flavors. Same state machine, same snapshot shape.

- [ ] **Step 2: Copy each whisper install endpoint to `server/api/desktop/llm/`**

For each of `install.{get,post,delete}.ts` and `[model].delete.ts`:
- Same h3 plumbing
- Swap `whisperInstallTask` import → `llmInstallTask`
- Swap `whisperModelPath` → `llmModelPath`
- Update VALID_MODELS to `['3b', '7b', '14b']`

- [ ] **Step 3: Implement `server/api/desktop/llm/status.get.ts`**

```ts
/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { createError, defineEventHandler } from 'h3';
import { detectHardware } from '../../../utils/hardware';
import { loadSettings } from '../../../utils/settings';
import { scanLlmModels } from '../../../../desktop/modelManager/llmScan';
import { recommendLlmModel } from '../../../../desktop/modelManager/llmConfig';
import { llmModelPath } from '../../../../desktop/modelManager/llmInstall';

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  void event;
  const [scan, hw, settings] = await Promise.all([
    scanLlmModels(),
    Promise.resolve(detectHardware()),
    Promise.resolve(loadSettings()),
  ]);
  const tagged = scan.map((m) => ({
    name: m.name,
    path: m.path,
    source: m.source,
    sizeBytes: m.sizeBytes,
    installed: m.path === llmModelPath(m.name),
  }));
  return {
    active: settings.llmModel,
    recommended: recommendLlmModel({ totalMemoryGB: hw.totalMemoryGB }),
    installed: tagged.filter((m) => m.installed),
    scanned: tagged.filter((m) => !m.installed),
  };
});
```

- [ ] **Step 4: Manual smoke (no automated test, these endpoints just route to the units we tested)**

Start `pnpm dev:desktop` and hit `curl 127.0.0.1:51301/api/desktop/llm/status -H 'x-subcast-token: ...'`. Expect 200 with the shape above.

- [ ] **Step 5: Commit**

```bash
git add server/utils/llmInstallTask.ts server/api/desktop/llm/
git commit -m "feat(llm): install task + REST endpoints (mirrors whisper install pattern)"
```

---

## Phase 3 — Business Code Switch

### Task 3.1: Replace Ollama HTTP calls in insightTasks/insights with llmClient

**Files:**
- Modify: `server/utils/insightTasks.ts`
- Modify: `server/utils/insights.ts`
- Modify: `server/utils/__tests__/insights.test.ts`

- [ ] **Step 1: Update `insights.test.ts` to mock `LLMBackend` instead of Ollama fetch**

Search the test for places that mock `fetch` against `localhost:11434`; replace with constructing a fake `LLMBackend` that returns a deterministic stream. Run the test; it should fail because the production code still calls `fetch`.

- [ ] **Step 2: Replace the Ollama call site in `server/utils/insights.ts`**

Find the function that does `fetch('http://localhost:11434/api/generate', ...)`. Replace:

```ts
import { llmBackend } from './llmClient';
// ...
const backend = llmBackend();
const stream = backend.chatStream({
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ],
  temperature: 0.2,
  maxTokens: 4096,
  signal,
});
for await (const chunk of stream) {
  if (chunk.delta) onToken(chunk.delta);
  if (chunk.finishReason === 'length') /* mark truncated */;
}
```

- [ ] **Step 3: Same swap in `server/utils/insightTasks.ts`**

Hunt for any direct Ollama URL or `fetch(...:11434...)`; convert to `llmBackend()` calls.

- [ ] **Step 4: Run test, expect pass**

Run: `pnpm vitest --run server/utils/__tests__/insights.test.ts`
Expected: 14 tests pass (same count as before the switch).

- [ ] **Step 5: Commit**

```bash
git add server/utils/insightTasks.ts server/utils/insights.ts server/utils/__tests__/insights.test.ts
git commit -m "feat(llm): switch insights pipeline to LLMBackend abstraction"
```

### Task 3.2: Settings field migration

**Files:**
- Modify: `server/utils/settings.ts`
- Create: `server/utils/__tests__/settings-migration.test.ts`

- [ ] **Step 1: Write migration test**

```ts
import { describe, it, expect } from 'vitest';
import { migrateLegacySettings } from '../settings';

describe('migrateLegacySettings', () => {
  it('drops the legacy ollamaModel field', () => {
    const result = migrateLegacySettings({
      whisperModel: 'small',
      ollamaModel: 'qwen2.5:7b',
      cacheLimitGB: 10,
      silenceThresholdMs: 10_000,
      debugMode: false,
    } as Record<string, unknown>);
    expect('ollamaModel' in result).toBe(false);
    expect((result as { llmModel?: string }).llmModel).toBeUndefined();
  });

  it('persists migration hint for the wizard', () => {
    const result = migrateLegacySettings({ ollamaModel: 'qwen2.5:14b' } as Record<string, unknown>);
    expect((result as { _migrationHint?: string })._migrationHint).toBe('14b');
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement migration in `server/utils/settings.ts`**

```ts
export interface SubcastSettings {
  whisperModel: WhisperModelName;
  llmModel: LlmModelId | undefined;
  cacheLimitGB: number;
  silenceThresholdMs: number;
  debugMode: boolean;
}

export const DEFAULT_SETTINGS: SubcastSettings = {
  whisperModel: 'base',
  llmModel: undefined,
  cacheLimitGB: 10,
  silenceThresholdMs: 10_000,
  debugMode: false,
};

export function migrateLegacySettings(parsed: Record<string, unknown>): Partial<SubcastSettings> & { _migrationHint?: LlmModelId } {
  const { ollamaModel, ...rest } = parsed;
  if (typeof ollamaModel === 'string') {
    const m = /^qwen2\.5:(3b|7b|14b)$/i.exec(ollamaModel);
    const hint = m ? (m[1]!.toLowerCase() as LlmModelId) : undefined;
    return { ...(rest as Partial<SubcastSettings>), _migrationHint: hint };
  }
  return rest as Partial<SubcastSettings>;
}

// In loadSettings:
const parsed = JSON.parse(row.value) as Record<string, unknown>;
const migrated = migrateLegacySettings(parsed);
// Persist the hint to a sidecar file the wizard can read, then strip it:
if (migrated._migrationHint) {
  // Write `<userData>/models/llm/.migration-hint.json` once, idempotent
}
const { _migrationHint, ...clean } = migrated;
return { ...DEFAULT_SETTINGS, ...clean };
```

- [ ] **Step 4: Run test, expect pass**

- [ ] **Step 5: Commit**

```bash
git add server/utils/settings.ts server/utils/__tests__/settings-migration.test.ts
git commit -m "feat(settings): migrate legacy ollamaModel field; write wizard hint"
```

---

## Phase 4 — Setup Wizard UI

### Task 4.1: Renumber wizard 3 → 2 steps

**Files:**
- Modify: `app/pages/setup-wizard.vue`

- [ ] **Step 1: Change `currentStep` type and all referencing logic**

```ts
const currentStep = ref<1 | 2>(1);
```

Search for all `currentStep === 2`, `currentStep === 3`, `enterStep(3)`, `goNextStep`, `goPrevStep` — update so step 2 (LLM) replaces what was step 3.

- [ ] **Step 2: Delete the old step 2 markup block (the entire `<template v-else-if="currentStep === 2">` Ollama detection section, lines ~860-923)**

Replace with nothing — that template branch is gone.

- [ ] **Step 3: Rename old step 3 `<template v-else>` to `<template v-else-if="currentStep === 2">` if needed**

Likely it's currently `v-else` which works for the last condition; but with only one fallthrough now we want it explicit.

- [ ] **Step 4: Delete all `ollama*` state refs unrelated to step 2 UI**

Search for `ollama`, `ollamaProbing`, `ollamaWaiting`, `ollamaPollTimer`, `probeOllamaStatus`, `startOllamaPolling`, `stopOllamaPolling`, `clickIveInstalled` — all gone.

- [ ] **Step 5: Update step progress bar (`<ol class="...progress">`) to iterate 2 steps instead of 3**

The loop currently does 3 iterations; reduce to 2 labels (Whisper / LLM).

- [ ] **Step 6: Run typecheck + lint**

```
pnpm exec eslint app/pages/setup-wizard.vue
pnpm exec tsc -p tsconfig.desktop.json --noEmit
```

Expected: no new errors (the existing import/first pre-existing error stays).

- [ ] **Step 7: Commit**

```bash
git add app/pages/setup-wizard.vue
git commit -m "refactor(ui): collapse setup wizard from 3 steps to 2 (drop Ollama step)"
```

### Task 4.2: Rewrite step 2 as LLM model picker

**Files:**
- Modify: `app/pages/setup-wizard.vue`
- Modify: `i18n/locales/{en,zh-CN}.json`

- [ ] **Step 1: Replace the QWEN_VARIANTS static const with LLM_OPTIONS from new API**

```ts
interface LlmStatusResp {
  active: LlmModelId | undefined;
  recommended: LlmModelId;
  installed: Array<{ name: LlmModelId; path: string; sizeBytes: number }>;
  scanned: Array<{ name: LlmModelId; path: string; source: string; sizeBytes: number }>;
}

const llmStatus = ref<LlmStatusResp | null>(null);
async function loadLlmStatus(): Promise<void> {
  llmStatus.value = await $fetch<LlmStatusResp>('/api/desktop/llm/status');
}
```

- [ ] **Step 2: Replace QWEN_VARIANTS rendering with a 3-card grid using `LLM_OPTIONS`**

Reuse the exact card markup from step 1 (Whisper):
- One card per `{ id: '3b' | '7b' | '14b' }`
- Radio bound to `selectedLlm`
- Show "✓ 已安装" badge if `llmStatus.installed.some(m => m.name === id)`
- Show "扫描到 (LM Studio)" hint with symlink/copy/ignore radio if `scanned.some(m => m.name === id)`
- Show "推荐" badge when `id === llmStatus.recommended`

- [ ] **Step 3: Add the "download mirror" select + "Pull" button bound to install endpoints**

```html
<Button :disabled="!canStartInstall" @click="startLlmInstall">
  下载 {{ LLM_MODELS[selectedLlm].filename }} ({{ formatBytes(LLM_MODELS[selectedLlm].sizeBytes) }})
</Button>
```

- [ ] **Step 4: Add install progress UI (reuse the existing Whisper install progress component shape)**

Poll `/api/desktop/llm/install` every 500ms while task is running. Same shape as whisper.

- [ ] **Step 5: Read `.migration-hint.json` and pre-select that tier**

```ts
const hint = await $fetch<{ id: LlmModelId } | null>('/api/desktop/llm/migration-hint').catch(() => null);
if (hint) selectedLlm.value = hint.id;
```

(Add a small endpoint `migration-hint.get.ts` that reads + deletes the file. ~20 lines.)

- [ ] **Step 6: Add the 8GB-RAM warning banner**

```html
<div v-if="(llmStatus?.totalMemoryGB ?? 999) < 8" class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
  {{ t('desktop.llm.lowMemoryWarning') }}
</div>
```

(Status endpoint needs to return `totalMemoryGB` — extend it.)

- [ ] **Step 7: i18n new strings (en + zh)**

```json
"llm": {
  "selectModel": "选择 AI 翻译/总结模型",
  "lowMemoryWarning": "你的机器内存较小 (<8 GB)，运行 AI 可能影响系统响应。可以跳过此步，AI 功能晚些在设置里配置。",
  "downloadButton": "下载 {filename} ({size})",
  "alreadyInstalled": "已安装",
  "foundIn": "已在 {source} 找到",
  ...
}
```

- [ ] **Step 8: Lint + smoke**

```
pnpm exec eslint app/pages/setup-wizard.vue
```

Then `pnpm dev:desktop`, run through the wizard step 2.

- [ ] **Step 9: Commit**

```bash
git add app/pages/setup-wizard.vue i18n/locales/
git commit -m "feat(ui): setup-wizard step 2 — LLM model picker with scan + mirror"
```

---

## Phase 5 — Settings + AppHeader Integration

### Task 5.1: Settings Models tab — LLM section

**Files:**
- Modify: `app/pages/settings.vue`
- Modify: `i18n/locales/{en,zh-CN}.json`

- [ ] **Step 1: Remove Ollama section markup from Models tab**

Search for the existing `<section>` that lists Ollama status + qwen model list; delete it.

- [ ] **Step 2: Add LLM section that mirrors the Whisper section structure**

```html
<section v-if="modelsData?.llm" class="space-y-3">
  <h2>{{ t('settings.models.llmHeader') }}</h2>
  <p class="text-sm text-muted-foreground">{{ t('settings.models.llmActive', { name: modelsData.llm.active ?? '—' }) }}</p>
  <div v-for="m in modelsData.llm.installed" :key="m.name" class="card-list flex items-center justify-between">
    <span>{{ m.filename }}</span>
    <div class="flex gap-2">
      <Button v-if="m.name !== modelsData.llm.active" size="sm" @click="setActiveLlm(m.name)">{{ t('settings.models.use') }}</Button>
      <Button size="sm" variant="ghost" @click="confirmDelete({ kind: 'llm', name: m.name, sizeBytes: m.sizeBytes })">{{ t('settings.models.delete') }}</Button>
    </div>
  </div>
  <NuxtLink to="/setup-wizard?step=2" class="text-sm text-primary">{{ t('settings.models.downloadMore') }}</NuxtLink>
</section>
```

- [ ] **Step 3: Modify `models.get.ts` API to return llm in place of ollama**

In `server/api/desktop/models.get.ts`, swap the ollama section for an llm section that queries `scanLlmModels` + filters installed.

- [ ] **Step 4: Wire setActiveLlm / delete confirm to new endpoints**

PUT `/api/settings` with `{ llmModel: id }`; DELETE `/api/desktop/llm/<id>`.

- [ ] **Step 5: Lint + smoke (settings page in dev mode)**

- [ ] **Step 6: Commit**

```bash
git add app/pages/settings.vue server/api/desktop/models.get.ts i18n/locales/
git commit -m "feat(ui): settings Models tab — LLM section (replaces Ollama)"
```

### Task 5.2: AppHeader chip readiness — llmReady

**Files:**
- Modify: `app/components/AppHeader.vue`
- Modify: `app/composables/useActiveModels.ts`
- Modify: `i18n/locales/{en,zh-CN}.json`

- [ ] **Step 1: Replace `ollamaModel` field with `llmModel` in `useActiveModels.ts`**

```ts
interface ActiveModels {
  whisperModel: string;
  llmModel: string;  // was ollamaModel
  whisperReady: boolean | null;
  llmReady: boolean | null;
}
```

Update `refreshFromDesktop()` to read `res.llm.installed` instead of `res.ollama.installed`.

- [ ] **Step 2: Replace `ollamaWarnMsg` etc. in AppHeader with `llmWarnMsg`**

Search-and-replace `ollamaModel` → `llmModel`, `ollamaReady` → `llmReady`, `ollamaWarnMsg` → `llmWarnMsg`. Also drop the "Ollama 未运行" specific case — replaced with just "AI 模型未安装" since there's no separate runtime state.

- [ ] **Step 3: Lint + smoke**

- [ ] **Step 4: Commit**

```bash
git add app/components/AppHeader.vue app/composables/useActiveModels.ts i18n/locales/
git commit -m "refactor(ui): AppHeader chip readiness uses llmModel (not ollamaModel)"
```

---

## Phase 6 — Delete Ollama Code

### Task 6.1: Delete all Ollama-specific files

**Files:**
- Delete: `desktop/ollamaDetector.ts`
- Delete: `server/api/desktop/ollama/status.get.ts`
- Delete: `server/api/desktop/ollama/fix-key.post.ts`
- Delete: `server/api/desktop/ollama/[name].delete.ts`
- Delete: `server/api/desktop/qwen/pull.get.ts`
- Delete: `server/api/desktop/qwen/pull.post.ts`
- Delete: `server/api/desktop/qwen/pull.delete.ts`
- Delete: `server/utils/qwenPullTask.ts`
- Delete: `desktop/modelManager/qwen.ts`
- Delete: `desktop/modelManager/__tests__/qwen.test.ts`

- [ ] **Step 1: Run the deletions**

```bash
git rm desktop/ollamaDetector.ts \
  server/api/desktop/ollama/status.get.ts \
  server/api/desktop/ollama/fix-key.post.ts \
  server/api/desktop/ollama/[model].delete.ts \
  server/api/desktop/qwen/pull.get.ts \
  server/api/desktop/qwen/pull.post.ts \
  server/api/desktop/qwen/pull.delete.ts \
  server/utils/qwenPullTask.ts \
  desktop/modelManager/qwen.ts \
  desktop/modelManager/__tests__/qwen.test.ts
rmdir server/api/desktop/ollama server/api/desktop/qwen 2>/dev/null || true
```

- [ ] **Step 2: Search for any remaining imports of the deleted modules; fix**

```bash
grep -rn 'ollamaDetector\|qwenPullTask\|ollama/status\|qwen/pull' --include='*.ts' --include='*.vue' .
```

Expected: no hits in production code. If anything left, refactor.

- [ ] **Step 3: Run full test suite + lint**

```
pnpm test
pnpm exec eslint .
```

Expected: all pass.

- [ ] **Step 4: Strip leftover i18n keys**

Delete the `desktop.ollama.*` and `desktop.qwen.*` sub-trees from `i18n/locales/{en,zh-CN}.json`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete Ollama / Qwen code paths superseded by llama-server backend"
```

---

## Phase 7 — Bundling, Smoke, Release

### Task 7.1: Wire llama-server into extraResources + binaryCheck

**Files:**
- Modify: `electron-builder.config.cjs`
- Modify: `desktop/binaryCheck.ts`
- Modify: `desktop/main.ts`

- [ ] **Step 1: Add llama-server to extraResources**

In `electron-builder.config.cjs`'s `buildExtraResources()`:

```js
// llama-server: same skip-if-missing pattern as whisper-cli
const llamaRel = `binaries/${t.os === 'mac' ? 'darwin' : t.os}-${t.arch}/llama-server${t.ext}`;
if (fs.existsSync(path.join(root, llamaRel))) {
  out.push({ from: llamaRel, to: `llama-server${t.ext}` });
} else {
  console.warn(`[electron-builder] llama-server missing at ${llamaRel} — packaging without it. Run scripts/fetch-llama-server.mjs.`);
}
```

- [ ] **Step 2: Update `desktop/binaryCheck.ts`**

```ts
const REQUIRED_BINARIES = ['whisper-cli', 'ffmpeg', 'ffprobe', 'llama-server'] as const;
```

- [ ] **Step 3: Update `afterPack` in electron-builder.config.cjs to also chmod + codesign llama-server**

Existing loop: add `'llama-server'` to the `for (const name of [...])` list.

- [ ] **Step 4: Inject llama-server config into Nitro via env vars**

`LlmServer` lives inside Nitro (see Task 1.2 rationale). Electron main only needs to pass it the binary path. In `desktop/nitroEmbed.ts`, after `process.env.SUBCAST_RESOURCES_PATH = ...`:

```ts
process.env.SUBCAST_LLM_BINARY_PATH = join(
  resolveResourcesPath(),
  'llama-server' + (process.platform === 'win32' ? '.exe' : ''),
);
```

`server/utils/llmServer.ts` reads `SUBCAST_LLM_BINARY_PATH` + the active model path from `loadSettings().llmModel` + `llmModelPath()`.

- [ ] **Step 5: Hook llmServer shutdown into the existing `/api/desktop/shutdown` handler**

In `server/api/desktop/shutdown.post.ts`:

```ts
import { getLlmServer } from '../../utils/llmServer';
// ... existing flush logic ...
await getLlmServer().stop();
```

`getLlmServer()` returns a lazily-constructed singleton. No work for Electron main beyond what it already does (POST to shutdown, then app.exit).

- [ ] **Step 6: Lint + manual smoke**

`pnpm build:desktop:main` should compile clean.

- [ ] **Step 7: Commit**

```bash
git add electron-builder.config.cjs desktop/binaryCheck.ts desktop/main.ts
git commit -m "feat(packaging): bundle llama-server in DMG + integrate with binaryCheck"
```

### Task 7.2: Smoke checklist + test:llm script

**Files:**
- Modify: `package.json`
- Modify: `docs/smoke-tests.md`

- [ ] **Step 1: Add `test:llm` script to package.json**

```json
"test:llm": "vitest --run server/utils/__tests__/llmClient.test.ts server/utils/__tests__/llmServer.test.ts desktop/modelManager/__tests__/llm*.test.ts"
```

- [ ] **Step 2: Update `docs/smoke-tests.md`** with the LLM section from the spec

- [ ] **Step 3: Commit**

```bash
git add package.json docs/smoke-tests.md
git commit -m "test: add test:llm script + LLM smoke checklist"
```

### Task 7.3: Version bump + Release notes

**Files:**
- Modify: `package.json`
- Create: `CHANGELOG.md` (if not present) or add entry to existing

- [ ] **Step 1: Bump version to 0.2.0**

In `package.json`: `"version": "0.2.0"`.

- [ ] **Step 2: Write release notes**

```markdown
## 0.2.0 — 内置 AI 推理引擎

**主要变化：Subcast 不再需要 Ollama**

- 内置 llama.cpp 推理引擎，AI Insights / 翻译开箱即用
- 模型在 setup wizard 里直接下载，支持 hf-mirror / ModelScope 国内镜像
- LM Studio / Jan / ~/.cache/llama.cpp 已有的 Qwen GGUF 可一键复用
- AI 推理懒启动 + 5 分钟空闲卸载，转录-only 场景 ~0 额外 RAM
- Setup wizard 从 3 步减为 2 步

**0.1 用户**：升级后第一次启动会进 setup wizard step 2 (LLM 模型)。如果之前装的 Ollama 仅用于 Subcast，现在可以卸载。

**新硬件门槛**：3B 模型 8 GB RAM，7B 模型推荐 16 GB+。8 GB Mac 会建议跳过 AI 设置。
```

- [ ] **Step 3: Manual: run full smoke**

```
node scripts/reset-for-first-run.mjs
pnpm build:desktop:mac
open dist-electron/Subcast-0.2.0-arm64.dmg
# install + run through full setup wizard
```

Check off every item in the smoke-tests.md LLM section.

- [ ] **Step 4: Commit + tag + push**

```bash
git add package.json CHANGELOG.md
git commit -m "release: v0.2.0 — llama.cpp inference engine"
git tag v0.2.0
git push origin main v0.2.0
```

GitHub Actions release workflow picks up the tag and publishes the DMG.

---

## Spec Coverage Check (Self-Review)

| Spec section | Implementation tasks |
|---|---|
| §1 Architecture | Tasks 1.2, 1.4, 7.1 |
| §2 New modules | Tasks 1.1-1.6, 2.1-2.4 |
| §2 Modified files | Tasks 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 7.1, 7.3 |
| §2 Deleted files | Task 6.1 |
| §2 CI | Tasks 0.1, 0.2 |
| §3 Wizard UI | Tasks 4.1, 4.2 |
| §4 Error handling / lifecycle | Tasks 1.2, 1.3, 1.5, 1.6 |
| §4 Dynamic timeout | Task 1.4 |
| §5 Abstraction | Task 1.1 |
| §6 Tests | Inline in every task + 7.2 |
| §7 Release | Tasks 7.1-7.3 |

All sections covered. No placeholders that aren't intentional (catalog sha256 is deferred to release time per spec § Appendix B).
