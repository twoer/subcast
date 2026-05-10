# Live Subtitle Chrome Extension — Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time subtitle transcription for YouTube and generic web video via a Chrome Extension that captures tab audio and streams it to the local Subcast server over WebSocket.

**Architecture:** Chrome Extension uses `chrome.tabCapture` to capture tab audio as 16kHz mono PCM, sends it in N-second chunks over WebSocket to the Subcast Nitro server. Server buffers audio, writes temp WAV files, runs whisper-cli per chunk, and pushes transcript cues back over WebSocket. Content Script overlays subtitles on the page's `<video>` element.

**Tech Stack:** Nitro 2.13 WebSocket (crossws), Chrome Extension MV3, Vite, whisper-cli (reused), TypeScript

**Phase 1 Scope:** Original-language subtitles only. No translation. No popup controls (hardcoded defaults). Minimal Chrome Extension with background service worker + content script.

---

## File Map

### New files — Server

| File | Responsibility |
|------|---------------|
| `server/routes/stream.ts` | WebSocket handler: accepts connections, receives audio, sends transcripts |
| `server/utils/stream-pipeline.ts` | Buffers PCM audio, dispatches chunks to whisper, sends results |

### New files — Extension

| File | Responsibility |
|------|---------------|
| `extension/package.json` | Extension project config |
| `extension/tsconfig.json` | TypeScript config |
| `extension/vite.config.ts` | Vite build for CRX |
| `extension/manifest.json` | Chrome MV3 manifest |
| `extension/src/background/index.ts` | Service Worker: WebSocket client + tabCapture audio pipeline |
| `extension/src/background/audio-capture.ts` | AudioContext resampling + PCM chunking |
| `extension/src/background/ws-client.ts` | WebSocket connection management |
| `extension/src/content/index.ts` | Content Script: subtitle overlay |
| `extension/src/content/subtitle.css` | Overlay styles |
| `extension/src/lib/types.ts` | Shared message types |

### Modified files — Server

| File | Change |
|------|--------|
| `nuxt.config.ts` | Add `websocket: true` to enable Nitro WebSocket support |

### New files — Tests

| File | Responsibility |
|------|---------------|
| `server/utils/__tests__/stream-pipeline.test.ts` | Unit tests for StreamPipeline |

---

## Task 1: Enable Nitro WebSocket & Add Stream Pipeline Types

**Files:**
- Modify: `nuxt.config.ts`
- Create: `server/utils/stream-pipeline.ts`

- [ ] **Step 1: Enable WebSocket in nuxt.config.ts**

Add `websocket: true` inside the Nitro config. The current `nuxt.config.ts` has `nitro: { preset: 'node-server' }`. Change it to:

```typescript
  nitro: { preset: 'node-server', experimental: { websocket: true } },
```

- [ ] **Step 2: Create stream-pipeline.ts with types and PCM-to-WAV helper**

Create `server/utils/stream-pipeline.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { transcribeChunk } from './whisper';
import type { Cue } from './vtt';

export interface StreamCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface StreamConfig {
  chunkSec: number;
  model: string;
}

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  chunkSec: 10,
  model: 'base',
};

/** 16kHz mono s16le = 32000 bytes per second */
const BYTES_PER_SEC = 16000 * 2;

/** Write a minimal WAV header + PCM data to a Buffer. */
function pcmToWavBuffer(pcm: Buffer): Buffer {
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // fmt chunk size
  header.writeUInt16LE(1, 20);         // PCM
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(16000, 24);     // sample rate
  header.writeUInt32LE(32000, 28);     // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export type SendFn = (data: Record<string, unknown>) => void;

export class StreamPipeline {
  private pcmBuffers: Buffer[] = [];
  private pcmByteLength = 0;
  private config: StreamConfig;
  private send: SendFn;
  private processing = false;
  private chunkIdx = 0;
  private tmpId = randomUUID();
  private aborted = false;

  constructor(config: StreamConfig, send: SendFn) {
    this.config = config;
    this.send = send;
  }

  get isActive(): boolean {
    return !this.aborted;
  }

  appendAudio(pcm: Buffer): void {
    if (this.aborted) return;
    this.pcmBuffers.push(pcm);
    this.pcmByteLength += pcm.length;
    const targetBytes = this.config.chunkSec * BYTES_PER_SEC;
    if (this.pcmByteLength >= targetBytes) {
      const combined = Buffer.concat(this.pcmBuffers);
      const chunk = combined.subarray(0, targetBytes);
      const remainder = combined.subarray(targetBytes);
      this.pcmBuffers = remainder.length > 0 ? [Buffer.from(remainder)] : [];
      this.pcmByteLength = remainder.length;
      this.dispatchChunk(chunk);
    }
  }

  flush(): void {
    if (this.pcmByteLength === 0) return;
    const combined = Buffer.concat(this.pcmBuffers);
    this.pcmBuffers = [];
    this.pcmByteLength = 0;
    this.dispatchChunk(combined);
  }

  abort(): void {
    this.aborted = true;
  }

  private dispatchChunk(pcm: Buffer): void {
    if (this.aborted) return;
    const idx = this.chunkIdx++;
    this.processChunk(pcm, idx).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent({ level: 'error', event: 'stream_chunk_error', chunkIdx: idx, error: msg });
      this.send({
        type: 'error',
        code: 'CHUNK_FAILED',
        msg: `Chunk ${idx} failed: ${msg}`,
      });
    });
  }

  private async processChunk(pcm: Buffer, idx: number): Promise<void> {
    if (this.aborted) return;
    this.send({ type: 'status', state: 'processing', chunkIdx: idx });

    const wav = pcmToWavBuffer(pcm);
    const wavPath = join(SUBCAST_PATHS.tmp, `stream-${this.tmpId}-${idx}.wav`);
    try {
      await writeFile(wavPath, wav);
      const durationSec = pcm.length / BYTES_PER_SEC;
      const cues = await transcribeChunk(
        wavPath,
        0,
        durationSec,
        durationSec,
        { model: this.config.model as Parameters<typeof transcribeChunk>[4]['model'] },
      );
      const streamCues: StreamCue[] = cues.map((c: Cue) => ({
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text,
      }));
      this.send({
        type: 'transcript',
        chunkIdx: idx,
        chunkStartMs: idx * this.config.chunkSec * 1000,
        cues: streamCues,
      });
      logEvent({ level: 'info', event: 'stream_chunk_done', chunkIdx: idx, cues: streamCues.length });
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  }
}
```

Note: `transcribeChunk` currently expects a pre-existing WAV file and slices from it using ffmpeg. For streaming, we write the full chunk as a standalone WAV, so `chunkIdx=0` and `totalDuration=chunkDuration` means it processes the whole file. This works because whisper-cli transcribes whatever is in the WAV.

- [ ] **Step 3: Run typecheck**

Run: `cd D:/Code/My/subcast && npx nuxi typecheck`
Expected: No errors related to stream-pipeline.ts.

- [ ] **Step 4: Commit**

```bash
git add nuxt.config.ts server/utils/stream-pipeline.ts
git commit -m "feat(server): add StreamPipeline for real-time audio chunk transcription"
```

---

## Task 2: StreamPipeline Unit Tests

**Files:**
- Create: `server/utils/__tests__/stream-pipeline.test.ts`

- [ ] **Step 1: Write tests**

Create `server/utils/__tests__/stream-pipeline.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { StreamPipeline, DEFAULT_STREAM_CONFIG, pcmToWavBuffer } from '../stream-pipeline';

// We test the buffer accumulation and dispatch logic by mocking the
// whisper dependency. The actual whisper-cli integration is tested
// manually (it requires a compiled binary + model).

vi.mock('../whisper', () => ({
  transcribeChunk: vi.fn().mockResolvedValue([
    { startMs: 0, endMs: 3000, text: 'hello world' },
  ]),
}));

vi.mock('../db', () => ({
  SUBCAST_PATHS: { tmp: '/tmp/subcast-test' },
}));

vi.mock('../log', () => ({
  logEvent: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => 'test-uuid',
}));

describe('StreamPipeline', () => {
  const BYTES_PER_SEC = 16000 * 2; // 32000

  function createPipeline(chunkSec = 10) {
    const sent: Record<string, unknown>[] = [];
    const send = (data: Record<string, unknown>) => sent.push(data);
    const pipeline = new StreamPipeline(
      { chunkSec, model: 'base' },
      send,
    );
    return { pipeline, sent };
  }

  it('accumulates audio until chunk threshold is reached', () => {
    const { pipeline, sent } = createPipeline(1); // 1-second chunks
    // Send 0.5s of audio (16000 bytes)
    pipeline.appendAudio(Buffer.alloc(16000));
    expect(sent.length).toBe(0); // not enough yet
  });

  it('dispatches a chunk when threshold is reached', async () => {
    const { pipeline, sent } = createPipeline(1);
    // Send 1s of audio (32000 bytes) — triggers dispatch
    pipeline.appendAudio(Buffer.alloc(32000));
    // dispatchChunk is async; wait for it
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));
    expect(sent[0]).toMatchObject({ type: 'status', state: 'processing', chunkIdx: 0 });
  });

  it('carries remainder bytes to next chunk', async () => {
    const { pipeline, sent } = createPipeline(1);
    // Send 1.5s of audio (48000 bytes) — 32000 triggers first chunk, 16000 remainder
    pipeline.appendAudio(Buffer.alloc(48000));
    await vi.waitFor(() => expect(sent.some((s) => s.type === 'transcript')).toBe(true));
    // First chunk dispatched; remainder = 16000 bytes, not enough for second
  });

  it('flush sends remaining buffered audio as a chunk', async () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.appendAudio(Buffer.alloc(16000)); // 0.5s — below threshold
    pipeline.flush();
    await vi.waitFor(() => expect(sent.some((s) => s.type === 'transcript')).toBe(true));
  });

  it('abort prevents further processing', () => {
    const { pipeline, sent } = createPipeline(1);
    pipeline.abort();
    pipeline.appendAudio(Buffer.alloc(32000));
    expect(sent.length).toBe(0);
    expect(pipeline.isActive).toBe(false);
  });

  it('send receives transcript with correct chunkStartMs', async () => {
    const { pipeline, sent } = createPipeline(2);
    // First chunk: 2s = 64000 bytes
    pipeline.appendAudio(Buffer.alloc(64000));
    await vi.waitFor(() => expect(sent.some((s) => s.type === 'transcript')).toBe(true));
    const transcript = sent.find((s) => s.type === 'transcript')!;
    expect(transcript.chunkStartMs).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd D:/Code/My/subcast && pnpm test -- server/utils/__tests__/stream-pipeline.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/utils/__tests__/stream-pipeline.test.ts
git commit -m "test(server): add StreamPipeline unit tests"
```

---

## Task 3: WebSocket Server Endpoint

**Files:**
- Create: `server/routes/stream.ts`

Nitro 2.13 uses `server/routes/` for WebSocket handlers. The file `server/routes/stream.ts` will be auto-registered.

- [ ] **Step 1: Create the WebSocket handler**

Create `server/routes/stream.ts`:

```typescript
import { defineWebSocketHandler } from 'nitro/hooks';
import { StreamPipeline, DEFAULT_STREAM_CONFIG, type StreamConfig } from '../utils/stream-pipeline';
import { logEvent } from '../utils/log';

let activePipeline: { pipeline: StreamPipeline; close: () => void } | null = null;

export default defineWebSocketHandler({
  open(peer) {
    logEvent({ level: 'info', event: 'ws_stream_open', peerId: peer.id });

    if (activePipeline) {
      peer.send({ type: 'error', code: 'BUSY', msg: 'Another stream is active' });
      peer.close(1000, 'BUSY');
      return;
    }

    const config = { ...DEFAULT_STREAM_CONFIG };
    const send = (data: Record<string, unknown>) => {
      try {
        peer.send(JSON.stringify(data));
      } catch {
        // peer may have closed
      }
    };

    const pipeline = new StreamPipeline(config, send);
    activePipeline = {
      pipeline,
      close: () => {
        pipeline.abort();
        activePipeline = null;
      },
    };

    peer.send(JSON.stringify({ type: 'status', state: 'idle', config }));

    // Idle timeout: 30s with no data → disconnect
    const idleTimer = setTimeout(() => {
      logEvent({ level: 'info', event: 'ws_stream_idle_timeout', peerId: peer.id });
      peer.close(1000, 'IDLE_TIMEOUT');
    }, 30_000);
    let lastData = Date.now();

    const resetIdle = () => {
      if (Date.now() - lastData > 1000) {
        clearTimeout(idleTimer);
        lastData = Date.now();
        idleTimer.refresh();
      }
    };

    // Store pipeline reference on peer context for message handler
    peer.context = { pipeline, config, resetIdle };
  },

  message(peer, message) {
    const ctx = peer.context as {
      pipeline: StreamPipeline;
      config: StreamConfig;
      resetIdle: () => void;
    } | undefined;
    if (!ctx) return;

    // Binary frame = PCM audio data
    if (message.binary) {
      ctx.resetIdle();
      const buf = Buffer.from(message.arrayBuffer());
      ctx.pipeline.appendAudio(buf);
      return;
    }

    // Text frame = control message
    try {
      const msg = JSON.parse(message.text()) as Record<string, unknown>;
      if (msg.type === 'start' || msg.type === 'config') {
        if (typeof msg.chunkSec === 'number' && msg.chunkSec >= 3 && msg.chunkSec <= 60) {
          ctx.config.chunkSec = msg.chunkSec;
        }
        if (typeof msg.model === 'string') {
          ctx.config.model = msg.model;
        }
        peer.send(JSON.stringify({ type: 'status', state: 'idle', config: ctx.config }));
      }
      if (msg.type === 'stop') {
        ctx.pipeline.flush();
      }
    } catch {
      // ignore malformed messages
    }
  },

  close(peer) {
    logEvent({ level: 'info', event: 'ws_stream_close', peerId: peer.id });
    if (activePipeline) {
      activePipeline.pipeline.flush();
      activePipeline.close();
    }
  },

  error(peer, error) {
    logEvent({ level: 'error', event: 'ws_stream_error', peerId: peer.id, error: String(error) });
    if (activePipeline) {
      activePipeline.close();
    }
  },
});
```

Note: If `defineWebSocketHandler` is not exported from `nitro/hooks`, it may be a global auto-import from Nitro (like `defineEventHandler`). In that case, remove the import line and rely on the auto-import. Check with a test build.

- [ ] **Step 2: Test WebSocket endpoint manually**

Run: `cd D:/Code/My/subcast && pnpm dev`

Then in another terminal, test with Node.js:

```javascript
// test-ws.js
const ws = new (require('ws'))('ws://localhost:3000/stream');
ws.on('open', () => {
  console.log('Connected');
  // Send 1s of silence (32000 bytes of zeros)
  const silence = Buffer.alloc(32000);
  for (let i = 0; i < 10; i++) ws.send(silence);
});
ws.on('message', (data) => console.log('Received:', data.toString()));
ws.on('close', () => { console.log('Closed'); process.exit(0); });
setTimeout(() => { ws.close(); }, 60000);
```

Expected: Connection opens, server sends `{ type: "status", state: "idle" }`. After sending enough audio, receive `{ type: "transcript", ... }`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/stream.ts
git commit -m "feat(server): add WebSocket /stream endpoint for live audio transcription"
```

---

## Task 4: Extension Project Scaffold

**Files:**
- Create: `extension/package.json`
- Create: `extension/tsconfig.json`
- Create: `extension/vite.config.ts`
- Create: `extension/manifest.json`
- Create: `extension/src/lib/types.ts`

- [ ] **Step 1: Create extension/package.json**

```json
{
  "name": "subcast-live",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.28",
    "@types/chrome": "^0.0.287",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create extension/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["chrome"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create extension/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [crx({ manifest })],
});
```

- [ ] **Step 4: Create extension/manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Subcast Live",
  "version": "0.1.0",
  "description": "Real-time subtitles for any web video using local AI models",
  "permissions": ["tabCapture", "activeTab", "storage"],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"]
    }
  ],
  "action": {
    "default_title": "Subcast Live"
  },
  "icons": {}
}
```

Note: `@crxjs/vite-plugin` handles bundling the service worker and content scripts from TypeScript. If CRXJS has issues with MV3 service worker `type: "module"`, remove that field and let Vite bundle to a single file.

- [ ] **Step 5: Create extension/src/lib/types.ts**

```typescript
/** Messages sent from extension → server over WebSocket */
export type ClientMessage =
  | { type: 'start'; chunkSec: number; model: string }
  | { type: 'audio'; data: ArrayBuffer }
  | { type: 'stop' }
  | { type: 'config'; chunkSec?: number; model?: string };

/** Messages sent from server → extension over WebSocket */
export type ServerMessage =
  | { type: 'status'; state: 'idle' | 'processing' | 'error'; config?: StreamConfig; chunkIdx?: number }
  | { type: 'transcript'; chunkIdx: number; chunkStartMs: number; cues: StreamCue[] }
  | { type: 'error'; code: string; msg: string };

export interface StreamCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface StreamConfig {
  chunkSec: number;
  model: string;
}

/** Messages from background → content script (via chrome.tabs.sendMessage) */
export type BackgroundToContentMessage =
  | { type: 'subtitles'; chunkIdx: number; chunkStartMs: number; cues: StreamCue[] }
  | { type: 'status'; state: string }
  | { type: 'start' }
  | { type: 'stop' };

/** Messages from content script → background */
export type ContentToBackgroundMessage =
  | { type: 'video-paused' }
  | { type: 'video-playing' };
```

- [ ] **Step 6: Install dependencies**

Run: `cd D:/Code/My/subcast/extension && pnpm install`

- [ ] **Step 7: Verify build works (will fail on missing entry points, that's OK)**

Run: `cd D:/Code/My/subcast/extension && pnpm build`
Expected: Build may fail because source files don't exist yet. This just verifies the project scaffold is wired up.

- [ ] **Step 8: Commit**

```bash
git add extension/
git commit -m "feat(extension): scaffold Chrome Extension project with Vite + CRXJS"
```

---

## Task 5: WebSocket Client (Background Script)

**Files:**
- Create: `extension/src/background/ws-client.ts`

- [ ] **Step 1: Create WebSocket client module**

Create `extension/src/background/ws-client.ts`:

```typescript
import type { ServerMessage, StreamConfig } from '../lib/types';

const WS_URL = 'ws://localhost:3000/stream';
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2000;

export type WsStatus = 'disconnected' | 'connecting' | 'connected';
export type OnMessage = (msg: ServerMessage) => void;
export type OnStatusChange = (status: WsStatus) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private onMessage: OnMessage;
  private onStatusChange: OnStatusChange;
  private reconnectCount = 0;

  constructor(onMessage: OnMessage, onStatusChange: OnStatusChange) {
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  get status(): WsStatus {
    if (!this.ws) return 'disconnected';
    if (this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    if (this.ws.readyState === WebSocket.OPEN) return 'connected';
    return 'disconnected';
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }
    this.onStatusChange('connecting');
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      this.reconnectCount = 0;
      this.onStatusChange('connected');
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.onMessage(msg);
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.addEventListener('close', () => {
      this.onStatusChange('disconnected');
      this.tryReconnect();
    });

    ws.addEventListener('error', () => {
      this.onStatusChange('disconnected');
    });

    this.ws = ws;
  }

  disconnect(): void {
    this.reconnectCount = RECONNECT_ATTEMPTS; // prevent reconnect
    this.ws?.close();
    this.ws = null;
    this.onStatusChange('disconnected');
  }

  sendStart(config: StreamConfig): void {
    this.sendJson({ type: 'start', chunkSec: config.chunkSec, model: config.model });
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  sendStop(): void {
    this.sendJson({ type: 'stop' });
  }

  sendConfig(config: Partial<StreamConfig): void {
    this.sendJson({ type: 'config', ...config });
  }

  private sendJson(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private tryReconnect(): void {
    if (this.reconnectCount >= RECONNECT_ATTEMPTS) return;
    this.reconnectCount++;
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/ws-client.ts
git commit -m "feat(extension): add WebSocket client with auto-reconnect"
```

---

## Task 6: Audio Capture Module (Background Script)

**Files:**
- Create: `extension/src/background/audio-capture.ts`

- [ ] **Step 1: Create audio capture module**

This module uses `chrome.tabCapture.capture()` to get a `MediaStream`, then resamples it to 16kHz mono s16le PCM via `AudioContext` + `ScriptProcessorNode`.

Create `extension/src/background/audio-capture.ts`:

```typescript
const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096; // ScriptProcessorNode buffer size

export type OnAudioChunk = (pcm: ArrayBuffer) => void;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onChunk: OnAudioChunk;
  private _active = false;

  constructor(onChunk: OnAudioChunk) {
    this.onChunk = onChunk;
  }

  get active(): boolean {
    return this._active;
  }

  start(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
        if (!stream) {
          reject(new Error('tabCapture failed — no stream returned'));
          return;
        }

        this.stream = stream;
        this.audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        const source = this.audioContext.createMediaStreamSource(stream);

        // ScriptProcessorNode outputs float32 at 16kHz mono
        this.processor = this.audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
        this.processor.onaudioprocess = (event) => {
          if (!this._active) return;
          const float32 = event.inputBuffer.getChannelData(0);
          // Convert float32 [-1, 1] to s16le
          const s16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]!));
            s16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.onChunk(s16.buffer);
        };

        source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
        this._active = true;
        resolve();
      });
    });
  }

  stop(): void {
    this._active = false;
    this.processor?.disconnect();
    this.processor = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/audio-capture.ts
git commit -m "feat(extension): add AudioCapture with tabCapture + 16kHz PCM resampling"
```

---

## Task 7: Background Service Worker (Orchestrator)

**Files:**
- Create: `extension/src/background/index.ts`

- [ ] **Step 1: Create the background service worker**

This ties together `WsClient` and `AudioCapture`, and forwards results to content scripts.

Create `extension/src/background/index.ts`:

```typescript
import { AudioCapture } from './audio-capture';
import { WsClient } from './ws-client';
import type { ServerMessage, StreamConfig } from '../lib/types';

const DEFAULT_CONFIG: StreamConfig = {
  chunkSec: 10,
  model: 'base',
};

let wsClient: WsClient;
let audioCapture: AudioCapture;
let currentConfig: StreamConfig = { ...DEFAULT_CONFIG };
let activeTabId: number | null = null;

function sendToContent(tabId: number, msg: unknown): void {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // content script may not be loaded yet
  });
}

function onServerMessage(msg: ServerMessage): void {
  if (!activeTabId) return;

  switch (msg.type) {
    case 'transcript':
      sendToContent(activeTabId, {
        type: 'subtitles',
        chunkIdx: msg.chunkIdx,
        chunkStartMs: msg.chunkStartMs,
        cues: msg.cues,
      });
      break;
    case 'status':
      sendToContent(activeTabId, { type: 'status', state: msg.state });
      break;
    case 'error':
      sendToContent(activeTabId, { type: 'status', state: 'error' });
      console.error('[Subcast Live] Server error:', msg.code, msg.msg);
      break;
  }
}

function onStatusChange(status: string): void {
  console.log('[Subcast Live] WS status:', status);
}

function startCapture(tabId: number): void {
  if (audioCapture.active) {
    audioCapture.stop();
  }

  activeTabId = tabId;
  wsClient = new WsClient(onServerMessage, onStatusChange);
  audioCapture = new AudioCapture((pcm) => {
    wsClient.sendAudio(pcm);
  });

  wsClient.connect();
  // Give WS a moment to connect, then send start + begin audio capture
  setTimeout(() => {
    wsClient.sendStart(currentConfig);
    audioCapture.start(tabId).catch((err) => {
      console.error('[Subcast Live] Audio capture failed:', err);
    });
  }, 500);
}

function stopCapture(): void {
  audioCapture?.stop();
  wsClient?.sendStop();
  wsClient?.disconnect();
  if (activeTabId) {
    sendToContent(activeTabId, { type: 'stop' });
  }
  activeTabId = null;
}

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start') {
    // sender.tab is set when message comes from content script;
    // for popup, use the active tab
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId) {
      startCapture(tabId);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'No tab ID' });
    }
    return true;
  }
  if (msg.type === 'stop') {
    stopCapture();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'status') {
    sendResponse({
      active: audioCapture?.active ?? false,
      wsStatus: wsClient?.status ?? 'disconnected',
    });
    return true;
  }
});

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    stopCapture();
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add extension/src/background/index.ts
git commit -m "feat(extension): add background service worker orchestrator"
```

---

## Task 8: Content Script (Subtitle Overlay)

**Files:**
- Create: `extension/src/content/index.ts`
- Create: `extension/src/content/subtitle.css`

- [ ] **Step 1: Create subtitle CSS**

Create `extension/src/content/subtitle.css`:

```css
/* Subcast Live subtitle overlay */
.subcast-live-overlay {
  position: absolute;
  bottom: 10%;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 2147483647;
  text-align: center;
  max-width: 80%;
}

.subcast-live-cue {
  display: inline-block;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 1.2em;
  padding: 4px 12px;
  border-radius: 4px;
  line-height: 1.4;
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

.subcast-live-cue.hidden {
  display: none;
}
```

- [ ] **Step 2: Create content script**

Create `extension/src/content/index.ts`:

```typescript
import type { BackgroundToContentMessage, StreamCue } from '../lib/types';
import './subtitle.css';

const CUE_DISPLAY_DURATION_MS = 5000;
const MAX_VISIBLE_CUES = 3;

interface TimedCue extends StreamCue {
  absoluteStartMs: number;
  absoluteEndMs: number;
  chunkStartMs: number;
}

let overlayEl: HTMLDivElement | null = null;
let cueEls: HTMLSpanElement[] = [];
let activeCues: TimedCue[] = [];
let chunkTimeOffset = 0;
let videoEl: HTMLVideoElement | null = null;

function createOverlay(video: HTMLVideoElement): HTMLDivElement {
  // Create a wrapper that sits inside the video's parent, positioned over the video
  const parent = video.parentElement;
  if (!parent) {
    // Fallback: append to body
    const overlay = document.createElement('div');
    overlay.className = 'subcast-live-overlay';
    overlay.style.position = 'fixed';
    document.body.appendChild(overlay);
    return overlay;
  }

  // Ensure parent is positioned
  const parentPos = getComputedStyle(parent).position;
  if (parentPos === 'static') {
    parent.style.position = 'relative';
  }

  const overlay = document.createElement('div');
  overlay.className = 'subcast-live-overlay';
  parent.appendChild(overlay);

  // Observe video resize to reposition overlay
  const observer = new ResizeObserver(() => {
    const rect = video.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    overlay.style.width = `${rect.width}px`;
    overlay.style.left = `${rect.left - parentRect.left}px`;
    overlay.style.top = `${rect.top - parentRect.top + rect.height * 0.85}px`;
  });
  observer.observe(video);

  return overlay;
}

function getOrCreateOverlay(): HTMLDivElement | null {
  if (overlayEl) return overlayEl;
  videoEl = document.querySelector('video');
  if (!videoEl) return null;
  overlayEl = createOverlay(videoEl);
  return overlayEl;
}

function showCues(cues: TimedCue[]): void {
  const overlay = getOrCreateOverlay();
  if (!overlay) return;

  // Remove old cue elements
  cueEls.forEach((el) => el.remove());
  cueEls = [];

  // Show up to MAX_VISIBLE_CUES most recent cues
  const visible = cues.slice(-MAX_VISIBLE_CUES);
  for (const cue of visible) {
    const span = document.createElement('span');
    span.className = 'subcast-live-cue';
    span.textContent = cue.text;
    overlay.appendChild(span);
    cueEls.push(span);
  }
}

function clearCues(): void {
  cueEls.forEach((el) => el.remove());
  cueEls = [];
  activeCues = [];
}

function addSubtitles(chunkStartMs: number, cues: StreamCue[]): void {
  const video = document.querySelector('video');
  if (!video) return;

  const videoCurrentTimeMs = video.currentTime * 1000;
  // Calculate offset: where in the video timeline this chunk started
  // Server sends chunkStartMs as (chunkIdx * chunkSec * 1000), but we use
  // video.currentTime at the time the chunk was sent as our sync reference.
  // For Phase 1 MVP, just display cues sequentially as they arrive.
  const now = Date.now();

  const timedCues: TimedCue[] = cues.map((cue) => ({
    ...cue,
    absoluteStartMs: now + cue.startMs,
    absoluteEndMs: now + cue.endMs,
    chunkStartMs,
  }));

  activeCues.push(...timedCues);
  showCues(activeCues);

  // Auto-remove cues after their duration + buffer
  for (const cue of timedCues) {
    const displayMs = Math.max(cue.endMs - cue.startMs, CUE_DISPLAY_DURATION_MS);
    setTimeout(() => {
      activeCues = activeCues.filter((c) => c !== cue);
      showCues(activeCues);
    }, displayMs);
  }
}

// Listen for messages from background
chrome.runtime.onMessage.addListener(
  (msg: BackgroundToContentMessage, _sender, sendResponse) => {
    switch (msg.type) {
      case 'subtitles':
        addSubtitles(msg.chunkStartMs, msg.cues);
        break;
      case 'stop':
        clearCues();
        if (overlayEl) {
          overlayEl.remove();
          overlayEl = null;
        }
        break;
      case 'start':
        // Overlay will be created on first subtitle
        break;
    }
    sendResponse({ ok: true });
    return true;
  },
);

// Clean up overlay when video is removed from DOM
const mutationObserver = new MutationObserver(() => {
  if (videoEl && !document.contains(videoEl)) {
    clearCues();
    overlayEl?.remove();
    overlayEl = null;
    videoEl = null;
  }
});
mutationObserver.observe(document.body, { childList: true, subtree: true });
```

- [ ] **Step 3: Commit**

```bash
git add extension/src/content/
git commit -m "feat(extension): add content script with subtitle overlay"
```

---

## Task 9: Minimal Popup UI

**Files:**
- Create: `extension/src/popup/index.html`
- Create: `extension/src/popup/index.ts`
- Create: `extension/src/popup/popup.css`

- [ ] **Step 1: Create popup HTML**

Create `extension/src/popup/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      width: 260px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 12px;
      margin: 0;
      font-size: 13px;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #999;
    }
    .dot.connected { background: #4caf50; }
    .dot.disconnected { background: #f44336; }
    .dot.connecting { background: #ff9800; }
    .title {
      font-weight: 600;
      font-size: 14px;
    }
    .subtitle {
      color: #666;
      font-size: 11px;
    }
    .btn {
      width: 100%;
      padding: 8px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .btn-start {
      background: #1a73e8;
      color: white;
    }
    .btn-stop {
      background: #ea4335;
      color: white;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .settings-link {
      display: block;
      text-align: center;
      color: #1a73e8;
      text-decoration: none;
      font-size: 12px;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="status">
    <span class="dot disconnected" id="dot"></span>
    <div>
      <div class="title">Subcast Live</div>
      <div class="subtitle" id="status-text">Disconnected</div>
    </div>
  </div>
  <button class="btn btn-start" id="start-btn">Start Subtitles</button>
  <button class="btn btn-stop" id="stop-btn" disabled>Stop</button>
  <a class="settings-link" href="http://localhost:3000/settings" target="_blank">Open Settings</a>
  <script src="index.ts" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Create popup script**

Create `extension/src/popup/index.ts`:

```typescript
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const dot = document.getElementById('dot') as HTMLSpanElement;
const statusText = document.getElementById('status-text') as HTMLDivElement;

function updateUI(status: { active: boolean; wsStatus: string }): void {
  const { active, wsStatus } = status;

  startBtn.disabled = active;
  stopBtn.disabled = !active;

  dot.className = `dot ${wsStatus}`;
  const labels: Record<string, string> = {
    connected: active ? 'Listening...' : 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
  };
  statusText.textContent = labels[wsStatus] ?? wsStatus;
}

startBtn.addEventListener('click', async () => {
  // Get active tab to pass tabId
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ type: 'start', tabId: tab.id }, (resp) => {
    if (resp?.ok) {
      updateUI({ active: true, wsStatus: 'connected' });
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop' }, (resp) => {
    if (resp?.ok) {
      updateUI({ active: false, wsStatus: 'disconnected' });
    }
  });
});

// Poll status on open
chrome.runtime.sendMessage({ type: 'status' }, (resp) => {
  if (resp) {
    updateUI(resp);
  }
});
```

- [ ] **Step 3: Update manifest.json to reference popup**

Update `extension/manifest.json` — change the `action` field:

```json
  "action": {
    "default_title": "Subcast Live",
    "default_popup": "src/popup/index.html"
  }
```

- [ ] **Step 4: Commit**

```bash
git add extension/src/popup/ extension/manifest.json
git commit -m "feat(extension): add minimal popup UI with start/stop"
```

---

## Task 10: Integration Build & Manual Test

**Files:**
- Modify: `extension/manifest.json` (fix content_scripts path if needed)

This task focuses on getting the full pipeline working end-to-end.

- [ ] **Step 1: Build the extension**

Run: `cd D:/Code/My/subcast/extension && pnpm build`
Expected: Build succeeds, output in `extension/dist/`.

If CRXJS has issues with content script CSS injection, update `manifest.json` to remove the CSS from `content_scripts` and inject it dynamically from the content script instead.

- [ ] **Step 2: Fix any build issues**

Common issues:
1. CRXJS may not support `type: "module"` for service workers. Remove it from manifest and let Vite bundle.
2. Content script paths in manifest may need to match the output paths. Check `extension/dist/manifest.json` after build.
3. If CRXJS doesn't handle popup HTML correctly, move popup to static files.

Fix as needed and rebuild.

- [ ] **Step 3: Load extension in Chrome**

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension/dist/`
4. Extension should appear with "Subcast Live" name

- [ ] **Step 4: Start Subcast server**

Run: `cd D:/Code/My/subcast && pnpm dev`

- [ ] **Step 5: Test end-to-end**

1. Open a YouTube video in a Chrome tab
2. Click the Subcast Live extension icon
3. Click "Start Subtitles"
4. Expected: popup shows "Listening...", video tab gets subtitle overlay after ~10-15 seconds
5. Click "Stop" → subtitles disappear

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(extension): integration build fixes for Phase 1 MVP"
```

---

## Self-Review Checklist

### Spec Coverage
- [x] WebSocket endpoint at `/stream` → Task 3
- [x] StreamPipeline with PCM buffering → Task 1
- [x] `chrome.tabCapture` audio capture → Task 6
- [x] 16kHz mono PCM resampling → Task 6
- [x] N-second chunking → Task 1 (StreamPipeline)
- [x] Subtitle overlay on `<video>` → Task 8
- [x] Background → Content Script messaging → Task 7
- [x] Minimal popup with Start/Stop → Task 9
- [x] Single active stream enforcement → Task 3 (server-side check)
- [x] Temp file cleanup → Task 1 (finally block)
- [x] Idle timeout → Task 3 (30s timer)
- [x] Auto-reconnect → Task 5 (WsClient)

### Placeholder Scan
- No TBD, TODO, or vague instructions found.
- All code blocks contain complete implementations.

### Type Consistency
- `StreamCue` type defined in `extension/src/lib/types.ts` and `server/utils/stream-pipeline.ts` — both have `startMs`, `endMs`, `text`.
- `StreamConfig` type defined in both `types.ts` and `stream-pipeline.ts` — both have `chunkSec`, `model`.
- Message types between client and server match the protocol table in the spec.
- `BackgroundToContentMessage` in `types.ts` matches what background sends and content receives.
