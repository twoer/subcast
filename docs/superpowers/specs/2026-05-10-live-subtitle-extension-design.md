# Live Subtitle Chrome Extension — Design Spec

**Date:** 2026-05-10
**Status:** Approved
**Scope:** Add real-time subtitle transcription + translation for YouTube and generic web video via Chrome Extension + local Subcast server.

## Overview

Extend Subcast to support real-time subtitle generation for online videos (YouTube and any web page with `<video>`). A Chrome Extension captures tab audio via `chrome.tabCapture`, streams it over WebSocket to the local Subcast server, which runs whisper.cpp for transcription and Ollama for translation. Results are pushed back over WebSocket and displayed as a subtitle overlay on the page.

The existing Nuxt web UI (upload → transcribe → playback) remains unchanged. The extension and server share only the backend inference pipeline.

## Architecture

```
Chrome Extension                    Subcast Server (localhost:3000)
┌──────────────┐                    ┌─────────────────────┐
│ tabCapture   │ ──WebSocket(PCM)─→ │ StreamPipeline      │
│              │                    │   ├─ whisper-cli     │
│ Content      │ ←─WebSocket(JSON)─ │   └─ Ollama         │
│ Script       │                    │                     │
│ (overlay)    │                    └─────────────────────┘
│ Popup        │
└──────────────┘
```

## Project Structure

```
subcast/                          (pnpm workspace root)
├── package.json                  (workspace config)
├── app/                          (existing Nuxt frontend — unchanged)
├── server/                       (existing Nitro server — extended)
│   ├── api/
│   │   └── stream.ts             (NEW: WebSocket upgrade endpoint)
│   └── utils/
│       ├── stream-pipeline.ts    (NEW: audio buffering + dispatch)
│       ├── whisper.ts            (existing — reused as-is)
│       └── ollama.ts             (existing — reused with small batch)
├── extension/                    (NEW: Chrome Extension)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── manifest.json             (Chrome MV3)
│   └── src/
│       ├── background/           (Service Worker: WS + tabCapture)
│       ├── content/              (Content Script: subtitle overlay)
│       ├── popup/                (Popup: minimal controls)
│       ├── lib/                  (shared: WS client, types)
│       └── assets/
└── docs/superpowers/specs/
```

- Extension built with Vite (no heavy framework like Plasmo).
- `extension/` has its own `package.json`; built via `pnpm --filter extension dev/build`.
- Shared TypeScript types (Cue, SSE frame format) available via pnpm workspace.

## Audio Capture Pipeline

1. **Tab audio capture:** `chrome.tabCapture.capture()` → `MediaStream`.
2. **Resampling:** `AudioContext` with 16kHz mono output → `ScriptProcessorNode` (or `AudioWorklet`) produces s16le PCM buffers.
3. **Chunking:** Accumulate PCM data until N seconds reached (default 10s; user-adjustable 5–30s). Send each chunk as a WebSocket binary frame.
4. **Server processing:** Receive PCM → write temp `.wav` → call `whisper-cli` → call Ollama for translation → push results back over WebSocket.
5. **Subtitle overlay:** Content Script receives translated cues, injects DOM elements positioned at the bottom of the `<video>` element.

**Chunk size trade-off:**
- Short (5s): lower latency, but whisper may split mid-sentence.
- Long (30s): better transcription quality, but 30+ seconds of end-to-end latency.

## Server: WebSocket Endpoint

### New files

- `server/api/stream.ts` — WebSocket upgrade handler.
- `server/utils/stream-pipeline.ts` — `StreamPipeline` class managing audio buffering and processing dispatch.

### Client → Server messages

| Type | Direction | Payload |
|------|-----------|---------|
| `start` | C→S | `{ chunkSec: 10, model: "base", targetLang: "zh-CN" }` |
| `audio` | C→S | Binary frame (PCM buffer) |
| `stop` | C→S | (no payload) |
| `config` | C→S | `{ chunkSec?: number, targetLang?: string, model?: string }` |

### Server → Client messages

| Type | Direction | Payload |
|------|-----------|---------|
| `transcript` | S→C | `{ cues: Array<{ startMs, endMs, text }> }` per chunk |
| `translated` | S→C | `{ cues: Array<{ startMs, endMs, text }> }` translated subtitles |
| `status` | S→C | `{ state: "processing" \| "idle" \| "error", msg? }` |
| `error` | S→C | `{ code: string, msg: string }` |

### StreamPipeline (server/utils/stream-pipeline.ts)

```typescript
class StreamPipeline {
  private buffer: Buffer[] = []
  private chunkSec: number
  private ws: WebSocket

  onAudio(data: Buffer): void {
    this.buffer.push(data)
    if (enough audio for chunkSec) {
      const wav = bufferToWav(this.buffer)
      this.buffer = []
      this.processChunk(wav) // async, non-blocking
    }
  }

  async processChunk(wav: Buffer): Promise<void> {
    // 1. Write temp wav file
    // 2. Call transcribeChunk() (reuse existing whisper logic)
    // 3. Send { type: "transcript", cues } to client
    // 4. Call translateAll() with small batch size (3-5 cues)
    // 5. Send { type: "translated", cues } to client
    // 6. Clean up temp file
  }
}
```

### Reuse of existing code

- `transcribeChunk()` in `server/utils/whisper.ts` — reused directly. Input changes from "slice from large wav" to "standalone small wav", but the whisper-cli invocation is identical.
- `translateAll()` in `server/utils/ollama.ts` — reused with reduced batch size (3–5 cues per batch instead of 40) for lower latency in streaming mode.
- Quality detection (`detectHallucination`) — reused for each chunk.

## Chrome Extension

### manifest.json (MV3)

```json
{
  "manifest_version": 3,
  "name": "Subcast Live",
  "version": "1.0",
  "permissions": ["tabCapture", "activeTab", "storage"],
  "background": { "service_worker": "src/background/index.ts" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["src/content/index.ts"],
    "css": ["src/content/subtitle.css"]
  }],
  "action": { "default_popup": "src/popup/index.html" }
}
```

### Background Service Worker

- Manages WebSocket connection to `ws://localhost:3000/api/stream`.
- Controls audio capture lifecycle: popup "Start" → `chrome.tabCapture.capture()` → pipe `MediaStream` through `AudioContext` (16kHz mono) → send PCM chunks via WebSocket.
- Forwards subtitle results from server to content script via `chrome.tabs.sendMessage()`.

### Content Script (Subtitle Overlay)

- Listens for subtitle messages from background.
- Injects subtitle DOM positioned at bottom of `<video>` element.
- Layout:
  ```
  ┌──────────────────────────────────┐
  │          Video frame              │
  │                                  │
  │   ┌────────────────────────┐     │
  │   │  Original (small, dim) │     │
  │   │  Translation (large)   │     │
  │   └────────────────────────┘     │
  └──────────────────────────────────┘
  ```
- Positioning: follows `<video>` element bottom edge, responsive via `ResizeObserver`.
- Display modes: original only / translation only / bilingual (user-selectable).
- YouTube-specific adaptation: detect YouTube player container for better positioning.

### Popup (Minimal UI)

- Start/Stop button.
- Chunk duration slider (5–30s).
- Transcription model dropdown (tiny/base/small/medium/large-v3/large-v3-turbo).
- Translation language dropdown (zh-CN, zh-TW, en-US, ja-JP, ko-KR, fr-FR, de-DE, es-ES).
- Display mode dropdown (original/translated/bilingual).
- Connection status indicator (connected/disconnected).
- "Settings" link → opens `http://localhost:3000/settings` (existing Nuxt settings page).

## Subtitle Synchronization

Each audio chunk sent from the extension includes the `video.currentTime` at the moment the chunk started recording. The server treats this as the chunk's absolute start offset.

When displaying subtitles:
- Each cue from the server has a relative `startMs`/`endMs` within the chunk.
- The content script computes the display time: `displayAt = chunkStartTime + cue.startMs`.
- If cumulative drift exceeds 2 seconds, auto-recalibrate by resetting the offset.

## Error Handling & Edge Cases

### Connection loss
- Extension auto-reconnects on WebSocket disconnect (up to 3 attempts, 2s interval).
- On reconnect, sends `start` message to resume; does not resend already-processed audio.
- If Subcast server is not running, popup shows "Disconnected" with a hint to start the server.

### Audio capture interruption
- User pauses video → extension detects `video.pause` event → sends `stop` → auto-sends `start` when playback resumes.
- User switches tab → `tabCapture` continues capturing the original tab (Chrome behavior); no interruption.
- User closes tab → audio stream ends naturally; server cleans up temp files.

### Concurrency
- Only 1 active streaming transcription allowed (server-side `StreamPipeline` singleton) to avoid GPU memory contention.
- If a batch TranscribeQueue task is running, streaming request queues until it completes.

### Resource cleanup
- Temp wav files cleaned up after each chunk is processed.
- WebSocket idle timeout: 30s with no audio data → auto-disconnect.
- Extension popup closing does not affect background audio capture or WebSocket connection.

## Implementation Phases

### Phase 1: MVP (original-language subtitles only)
- Extension: tabCapture + PCM streaming + subtitle overlay.
- Server: WebSocket endpoint + StreamPipeline + whisper transcription.
- No translation, no popup controls (hardcoded defaults).

### Phase 2: Translation + Popup Controls
- Server: real-time translation pipeline (small batch, 3–5 cues).
- Extension: bilingual subtitle display, popup control panel.
- User-adjustable parameters (chunk duration, model, language, display mode).

### Phase 3: Polish & Robustness
- Auto-reconnect, pause/resume, sync calibration.
- YouTube player-specific adaptation.
- Nuxt settings page: add "Extension connection status" indicator.
