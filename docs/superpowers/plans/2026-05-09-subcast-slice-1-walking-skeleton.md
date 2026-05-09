# Subcast Slice 1: Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop a 30-second mp4 into the browser → see Whisper-generated cues stream into a `<pre>` block via SSE, validating the Nuxt Nitro + nodejs-whisper + SSE chain end-to-end.

**Architecture:** A Nuxt 4 monolith with two Nitro endpoints (POST upload, GET transcribe-SSE) backed by `better-sqlite3` (one `videos` table only) and a single in-memory boolean lock (no queue). Whisper runs once-per-video via `nodejs-whisper` (model hardcoded to `base`); resulting VTT is parsed and cues are streamed to the browser through h3's `createEventStream`. Two minimal Vue pages: a dropzone and a `<pre>`-based SSE viewer. No translation, no `<video>` element, no caching, no UI polish.

**Tech Stack:** Nuxt 4 / Vue 3 / TypeScript (strict) / Tailwind CSS / better-sqlite3 / nodejs-whisper / h3 SSE / vitest (1 test file)

**Reference:** `docs/superpowers/specs/2026-05-09-subcast-design.md` §1, §2 (videos table only), §3 (transcribe events: status/cue/done/error), §5 (Fatal-only for slice 1), §7 (TDD only `streamSha256`).

---

## File Structure

| Path | Purpose |
|---|---|
| `package.json` | deps + scripts |
| `nuxt.config.ts` | Nuxt + Tailwind + Nitro config |
| `tsconfig.json` | extends `.nuxt/tsconfig.json`, strict on |
| `vitest.config.ts` | vitest using Nuxt environment |
| `tailwind.config.ts` | Tailwind content paths |
| `app/assets/css/tailwind.css` | `@tailwind` directives |
| `app/pages/index.vue` | upload dropzone (raw HTML, no shadcn) |
| `app/pages/player/[hash].vue` | EventSource → `<pre>` SSE viewer |
| `server/utils/db.ts` | `better-sqlite3` singleton + `videos` schema bootstrap |
| `server/utils/ffmpeg.ts` | `streamSha256(stream)` (Slice 1 only this; ffmpeg integration deferred) |
| `server/utils/whisper.ts` | `transcribeOnce(absPath): AsyncIterable<Cue>` wrapper around `nodejs-whisper` |
| `server/utils/sse.ts` | tiny helper: format `{event, data}` → SSE frame string |
| `server/utils/vtt.ts` | minimal VTT parse (just enough for whisper output → Cue[]) |
| `server/api/upload.post.ts` | multipart in → stream sha256 + write `~/.subcast/videos/{sha}.{ext}` + insert row → `{ hash }` |
| `server/api/transcribe.get.ts` | SSE handler with `isTranscribing` boolean lock |
| `server/utils/__tests__/ffmpeg.test.ts` | unit test for `streamSha256` |

**Out of scope for Slice 1** (tracked in spec §6 Slice 2-9): `transcribe_tasks`/`chunks`/`translate_tasks`/`subtitles`/`settings` tables, queue, cache hit, real `<video>` + `<track>`, hallucination retry, silent segments, word-level timestamps, translation, i18n, Pinia, shadcn, error drawer, JSONL logs, hardware tier detection.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `nuxt.config.ts`, `tsconfig.json`, `app/assets/css/tailwind.css`, `tailwind.config.ts`, `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "subcast",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build",
    "preview": "nuxt preview",
    "typecheck": "nuxt typecheck",
    "test": "vitest --run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "nodejs-whisper": "^0.2.9",
    "nuxt": "^4.4.0",
    "vue": "^3.5.0",
    "vue-router": "^4.4.0"
  },
  "devDependencies": {
    "@nuxtjs/tailwindcss": "^6.12.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "packageManager": "pnpm@9.12.0"
}
```

- [ ] **Step 2: Install deps**

Run: `pnpm install`
Expected: pnpm completes; `node_modules/` populated; no peer-dep errors.

- [ ] **Step 3: Create `nuxt.config.ts`**

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-05-01',
  modules: ['@nuxtjs/tailwindcss'],
  css: ['~/assets/css/tailwind.css'],
  typescript: { strict: true, typeCheck: false },
  nitro: {
    preset: 'node-server',
  },
  devServer: {
    host: '0.0.0.0',
    port: 3000,
  },
});
```

- [ ] **Step 4: Create `tsconfig.json`**

```json
{
  "extends": "./.nuxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 5: Create `tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{vue,js,ts}',
    './server/**/*.{js,ts}',
  ],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 6: Create `app/assets/css/tailwind.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 7: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/__tests__/**/*.test.ts'],
  },
});
```

- [ ] **Step 8: Smoke verify `pnpm dev`**

Run: `pnpm dev`
Expected: Nitro server starts and prints `Local: http://localhost:3000/`. No errors. Open browser → see default Nuxt welcome page (since no `pages/index.vue` yet, it falls back to NuxtWelcome).

Press Ctrl+C to stop.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml nuxt.config.ts tsconfig.json tailwind.config.ts vitest.config.ts app/assets/css/tailwind.css
git commit -m "feat(slice-1): scaffold Nuxt 4 + Tailwind + vitest"
```

---

## Task 2: SQLite Singleton + `videos` Table

**Files:**
- Create: `server/utils/db.ts`

- [ ] **Step 1: Create `server/utils/db.ts`**

```ts
// server/utils/db.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUBCAST_HOME = join(homedir(), '.subcast');
const DB_PATH = join(SUBCAST_HOME, 'data.sqlite');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(SUBCAST_HOME, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        sha256          TEXT PRIMARY KEY,
        original_name   TEXT NOT NULL,
        ext             TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL,
        duration_s      REAL,
        created_at      INTEGER NOT NULL,
        last_opened_at  INTEGER NOT NULL
      );
    `);
    db.pragma('user_version = 1');
  }
}

export const SUBCAST_PATHS = {
  home: SUBCAST_HOME,
  videos: join(SUBCAST_HOME, 'videos'),
  cache: join(SUBCAST_HOME, 'cache'),
  logs: join(SUBCAST_HOME, 'logs'),
  tmp: join(SUBCAST_HOME, 'tmp'),
} as const;
```

- [ ] **Step 2: Smoke verify init runs**

Run: `node --input-type=module -e "import('./server/utils/db.ts').then(m => { m.getDb(); console.log('OK'); })"`

Note: Nitro auto-imports work only inside Nitro runtime. For this smoke test, you may instead create a one-off `server/api/health.get.ts` returning `{ ok: true, dbPath: SUBCAST_PATHS.home }`, run `pnpm dev`, then `curl http://localhost:3000/api/health` and confirm `~/.subcast/data.sqlite` exists.

Run: `ls -la ~/.subcast/`
Expected: `data.sqlite` file present, ~12KB after migrations.

Run: `sqlite3 ~/.subcast/data.sqlite '.tables'`
Expected: `videos`

Run: `sqlite3 ~/.subcast/data.sqlite 'PRAGMA user_version;'`
Expected: `1`

(Delete the throwaway `health.get.ts` before commit if you created it.)

- [ ] **Step 3: Commit**

```bash
git add server/utils/db.ts
git commit -m "feat(slice-1): sqlite singleton + videos table migration v1"
```

---

## Task 3: `streamSha256` (TDD — the only unit-tested piece in Slice 1)

**Files:**
- Create: `server/utils/__tests__/ffmpeg.test.ts`
- Create: `server/utils/ffmpeg.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/utils/__tests__/ffmpeg.test.ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { streamSha256 } from '../ffmpeg';

describe('streamSha256', () => {
  it('computes hex sha256 of "hello world"', async () => {
    const stream = Readable.from(Buffer.from('hello world'));
    const hash = await streamSha256(stream);
    expect(hash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    );
  });

  it('returns sha256 of empty data for empty stream', async () => {
    const stream = Readable.from(Buffer.from(''));
    const hash = await streamSha256(stream);
    expect(hash).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});
```

(Verify the expected values out-of-band: `printf 'hello world' | shasum -a 256` → `b94d...`; `printf '' | shasum -a 256` → `e3b0...`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../ffmpeg'` or similar.

- [ ] **Step 3: Implement `streamSha256`**

```ts
// server/utils/ffmpeg.ts
import { createHash } from 'node:crypto';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Compute SHA-256 of a stream's content (read-only, no side effects).
 * Slice 1 does NOT call this in the upload path — `upload.post.ts` uses an
 * inline tee that hashes AND writes in one pass for performance. This util
 * is built early because spec §7 covers it; first real use is Slice 6
 * (companion subtitle integrity check) and Slice 9 (diagnostic bundle).
 */
export async function streamSha256(input: Readable): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    input,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add server/utils/ffmpeg.ts server/utils/__tests__/ffmpeg.test.ts
git commit -m "feat(slice-1): streamSha256 with vitest coverage"
```

---

## Task 4: Whisper Wrapper + VTT Parser

**Files:**
- Create: `server/utils/vtt.ts`
- Create: `server/utils/whisper.ts`

- [ ] **Step 1: Create minimal VTT parser**

```ts
// server/utils/vtt.ts
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMESTAMP_RE =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

function tsToMs(h: string, m: string, s: string, ms: string): number {
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(m, 10) * 60_000 +
    parseInt(s, 10) * 1_000 +
    parseInt(ms, 10)
  );
}

export function parseVtt(content: string): Cue[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i]?.match(TIMESTAMP_RE);
    if (!match) {
      i++;
      continue;
    }
    const startMs = tsToMs(match[1]!, match[2]!, match[3]!, match[4]!);
    const endMs = tsToMs(match[5]!, match[6]!, match[7]!, match[8]!);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      textLines.push(lines[i]!);
      i++;
    }
    if (textLines.length > 0) {
      cues.push({ startMs, endMs, text: textLines.join('\n') });
    }
  }
  return cues;
}
```

- [ ] **Step 2: Create whisper wrapper**

```ts
// server/utils/whisper.ts
import { readFile } from 'node:fs/promises';
import { nodewhisper } from 'nodejs-whisper';
import { parseVtt, type Cue } from './vtt';

export interface TranscribeOnceOptions {
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
}

/**
 * Slice 1: full-blocking transcribe. nodejs-whisper writes a .vtt next to the
 * input file; we read it and yield cues one-by-one with a tiny delay so the
 * SSE consumer sees a stream-like progression. Real chunk-level streaming is
 * Slice 3's job.
 */
export async function* transcribeOnce(
  absPath: string,
  opts: TranscribeOnceOptions = {},
): AsyncIterable<Cue> {
  await nodewhisper(absPath, {
    modelName: opts.model ?? 'base',
    autoDownloadModelName: opts.model ?? 'base',
    removeWavFileAfterExecution: true,
    withCuda: false,
    whisperOptions: {
      outputInVtt: true,
      timestamps_length: 20,
      splitOnWord: false,
    },
  });
  const vttPath = absPath.replace(/\.[^.]+$/, '.vtt');
  const vtt = await readFile(vttPath, 'utf8');
  const cues = parseVtt(vtt);
  for (const cue of cues) {
    yield cue;
    await new Promise((r) => setTimeout(r, 20));
  }
}
```

- [ ] **Step 3: Smoke verify with a 5-second sample**

Place a small `.wav` (5-10 seconds of speech) at `/tmp/sample.wav` (e.g., `say -o /tmp/sample.aiff "the quick brown fox" && ffmpeg -i /tmp/sample.aiff /tmp/sample.wav` on macOS).

Create a one-off `server/api/whisper-smoke.get.ts`:

```ts
// Nitro auto-imports transcribeOnce from server/utils/whisper.ts.
export default defineEventHandler(async () => {
  const cues = [];
  for await (const cue of transcribeOnce('/tmp/sample.wav')) {
    cues.push(cue);
  }
  return { count: cues.length, cues };
});
```

Run: `pnpm dev` then `curl -s http://localhost:3000/api/whisper-smoke | jq .`
Expected: JSON with `count >= 1` and cues containing recognizable text.

(First run takes minutes — `nodejs-whisper` downloads the `base` model.)

Delete `whisper-smoke.get.ts` before commit.

- [ ] **Step 4: Commit**

```bash
git add server/utils/vtt.ts server/utils/whisper.ts
git commit -m "feat(slice-1): nodejs-whisper wrapper + minimal VTT parser"
```

---

## Task 5: SSE Helper + Upload Endpoint

**Files:**
- Create: `server/utils/sse.ts`
- Create: `server/api/upload.post.ts`

- [ ] **Step 1: Create SSE helper**

```ts
// server/utils/sse.ts
export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
  id?: number | string;
}

export function formatSse(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  lines.push('', '');
  return lines.join('\n');
}
```

- [ ] **Step 2: Create upload endpoint**

```ts
// server/api/upload.post.ts
// Nitro auto-imports getDb / SUBCAST_PATHS from server/utils/db.ts.
import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const ALLOWED_EXT = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'];
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event);
  const file = formData.get('video');
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, statusMessage: 'video field missing' });
  }
  if (file.size > MAX_BYTES) {
    throw createError({ statusCode: 400, statusMessage: 'file > 2GB' });
  }
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: `unsupported ext ${ext}` });
  }

  await mkdir(SUBCAST_PATHS.tmp, { recursive: true });
  await mkdir(SUBCAST_PATHS.videos, { recursive: true });

  const tmpPath = join(SUBCAST_PATHS.tmp, `${Date.now()}-${file.name}`);
  const hash = createHash('sha256');
  const writeFile = createWriteStream(tmpPath);

  await pipeline(
    Readable.fromWeb(file.stream() as never),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        writeFile.write(chunk, cb);
      },
      final(cb) {
        writeFile.end(cb);
      },
    }),
  );

  const sha = hash.digest('hex');
  const finalPath = join(SUBCAST_PATHS.videos, `${sha}${ext}`);
  await rename(tmpPath, finalPath);

  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
  ).run(sha, file.name, ext, file.size, now, now);

  return { hash: sha };
});
```

- [ ] **Step 3: Smoke verify upload**

Create a small test file:
```bash
ffmpeg -f lavfi -i sine=frequency=440:duration=5 -c:a aac /tmp/test.mp4
```

Run: `pnpm dev` (in another terminal)

Run: `curl -s -F video=@/tmp/test.mp4 http://localhost:3000/api/upload`
Expected: `{"hash":"<64-char hex>"}`

Run: `ls -la ~/.subcast/videos/`
Expected: a file `<hash>.mp4` matching the returned hash.

Run: `sqlite3 ~/.subcast/data.sqlite 'SELECT sha256, original_name, size_bytes FROM videos;'`
Expected: 1 row with matching hash, `test.mp4`, and the file size.

Verify hash matches:
Run: `shasum -a 256 /tmp/test.mp4` and compare to the API response. Should be identical.

- [ ] **Step 4: Commit**

```bash
git add server/utils/sse.ts server/api/upload.post.ts
git commit -m "feat(slice-1): POST /api/upload with streaming sha256 + videos row"
```

---

## Task 6: Transcribe SSE Endpoint

**Files:**
- Create: `server/api/transcribe.get.ts`

- [ ] **Step 1: Create transcribe endpoint**

```ts
// server/api/transcribe.get.ts
// Nitro auto-imports getDb / SUBCAST_PATHS / transcribeOnce / formatSse.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

let isTranscribing = false;

export default defineEventHandler(async (event) => {
  const { hash } = getQuery(event);
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const row = db
    .prepare('SELECT sha256, ext FROM videos WHERE sha256 = ?')
    .get(hash) as { sha256: string; ext: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  if (isTranscribing) {
    throw createError({ statusCode: 409, statusMessage: 'ALREADY_RUNNING' });
  }
  isTranscribing = true;

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const taskId = randomUUID();
  const requestId = randomUUID();
  const videoPath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);

  if (!existsSync(videoPath)) {
    isTranscribing = false;
    throw createError({ statusCode: 500, statusMessage: 'VIDEO_FILE_MISSING' });
  }

  return new Promise<void>((resolve, reject) => {
    const stream = event.node.res;

    let frameId = 0;
    const send = (frame: { event: string; data: Record<string, unknown> }) => {
      stream.write(formatSse({ ...frame, id: frameId++ }));
    };

    const heartbeat = setInterval(() => {
      stream.write(': heartbeat\n\n');
    }, 15_000);

    (async () => {
      try {
        send({
          event: 'status',
          data: { taskId, requestId, status: 'running', model: 'base' },
        });
        let chunkIdx = 0;
        for await (const cue of transcribeOnce(videoPath)) {
          send({
            event: 'cue',
            data: {
              taskId,
              requestId,
              chunkIdx: chunkIdx++,
              startMs: cue.startMs,
              endMs: cue.endMs,
              text: cue.text,
            },
          });
        }
        send({ event: 'done', data: { taskId, requestId, totalCues: chunkIdx } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({
          event: 'error',
          data: { taskId, requestId, code: 'FATAL_UNKNOWN', msg },
        });
      } finally {
        clearInterval(heartbeat);
        isTranscribing = false;
        stream.end();
        resolve();
      }
    })().catch(reject);

    event.node.req.on('close', () => {
      clearInterval(heartbeat);
      isTranscribing = false;
    });
  });
});
```

- [ ] **Step 2: Smoke verify SSE stream**

Use the hash returned from Task 5's smoke test (or upload again).

Run: `curl -N "http://localhost:3000/api/transcribe?hash=<hash>"`
Expected: A stream of lines:
```
id: 0
event: status
data: {"taskId":"...","requestId":"...","status":"running","model":"base"}

id: 1
event: cue
data: {"taskId":"...","requestId":"...","chunkIdx":0,"startMs":0,"endMs":3240,"text":"..."}

...

event: done
data: {"taskId":"...","requestId":"...","totalCues":N}
```

Then connection closes.

- [ ] **Step 3: Verify the lock**

While the first curl is still running, in another terminal:
Run: `curl -i "http://localhost:3000/api/transcribe?hash=<same-hash>"`
Expected: HTTP 409 with statusMessage `ALREADY_RUNNING`.

- [ ] **Step 4: Commit**

```bash
git add server/api/transcribe.get.ts
git commit -m "feat(slice-1): GET /api/transcribe SSE with isTranscribing lock"
```

---

## Task 7: Frontend — Index Page (Dropzone)

**Files:**
- Create: `app/pages/index.vue`

- [ ] **Step 1: Create dropzone page**

```vue
<!-- app/pages/index.vue -->
<script setup lang="ts">
const isUploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

async function uploadFile(file: File) {
  error.value = null;
  isUploading.value = true;
  try {
    const formData = new FormData();
    formData.append('video', file);
    const res = await $fetch<{ hash: string }>('/api/upload', {
      method: 'POST',
      body: formData,
    });
    await navigateTo(`/player/${res.hash}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'upload failed';
  } finally {
    isUploading.value = false;
  }
}

function onPickFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void uploadFile(f);
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) void uploadFile(f);
}
</script>

<template>
  <main class="min-h-screen flex items-center justify-center p-8 bg-gray-50">
    <div class="w-full max-w-xl">
      <h1 class="text-3xl font-bold mb-6 text-center">Subcast (Slice 1)</h1>

      <div
        class="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center bg-white hover:border-blue-400 transition"
        @dragover.prevent
        @drop="onDrop"
      >
        <p class="mb-4 text-gray-600">Drop a video file here, or</p>
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="isUploading"
          @click="fileInput?.click()"
        >
          {{ isUploading ? 'Uploading…' : 'Choose file' }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="video/*,audio/*"
          class="hidden"
          @change="onPickFile"
        />
      </div>

      <p v-if="error" class="mt-4 text-red-600 text-sm">{{ error }}</p>
    </div>
  </main>
</template>
```

- [ ] **Step 2: Smoke verify dropzone**

Run: `pnpm dev`
Open: http://localhost:3000

Expected: Dropzone visible with title "Subcast (Slice 1)".

Drop `/tmp/test.mp4` (from Task 5 smoke test) onto the box.
Expected: Button changes to "Uploading…" → page navigates to `/player/<hash>` (next task implements that page; for now you'll see the default Nuxt 404 — that's OK).

- [ ] **Step 3: Commit**

```bash
git add app/pages/index.vue
git commit -m "feat(slice-1): index page with drag-and-drop upload"
```

---

## Task 8: Frontend — Player Page (SSE Viewer)

**Files:**
- Create: `app/pages/player/[hash].vue`

- [ ] **Step 1: Create player page**

```vue
<!-- app/pages/player/[hash].vue -->
<script setup lang="ts">
const route = useRoute();
const hash = computed(() => String(route.params.hash));

const lines = ref<string[]>([]);
const status = ref<'idle' | 'running' | 'done' | 'error'>('idle');
const errMsg = ref<string | null>(null);

let es: EventSource | null = null;

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  const k = String(ms % 1000).padStart(3, '0');
  return `${m}:${s}.${k}`;
}

onMounted(() => {
  status.value = 'running';
  es = new EventSource(`/api/transcribe?hash=${hash.value}`);

  es.addEventListener('status', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    if (data.status === 'running') status.value = 'running';
  });

  es.addEventListener('cue', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    lines.value.push(`[${fmt(data.startMs)}-${fmt(data.endMs)}] ${data.text}`);
  });

  es.addEventListener('done', () => {
    status.value = 'done';
    lines.value.push('[done]');
    es?.close();
  });

  es.addEventListener('error', (e) => {
    const raw = (e as MessageEvent).data;
    if (raw) {
      try {
        const data = JSON.parse(raw);
        errMsg.value = `${data.code}: ${data.msg}`;
      } catch {
        errMsg.value = 'connection lost';
      }
    } else {
      errMsg.value = 'connection lost';
    }
    status.value = 'error';
    es?.close();
  });
});

onBeforeUnmount(() => {
  es?.close();
});
</script>

<template>
  <main class="min-h-screen p-8 bg-gray-900 text-gray-100 font-mono">
    <div class="max-w-4xl mx-auto">
      <h1 class="text-xl mb-4">
        <NuxtLink to="/" class="text-blue-300 hover:underline">←</NuxtLink>
        Player — {{ hash.slice(0, 12) }}…
        <span
          class="ml-3 text-sm px-2 py-0.5 rounded"
          :class="{
            'bg-yellow-600': status === 'running',
            'bg-green-600': status === 'done',
            'bg-red-600': status === 'error',
          }"
        >{{ status }}</span>
      </h1>

      <p v-if="errMsg" class="text-red-400 mb-4">{{ errMsg }}</p>

      <pre class="bg-black/40 p-4 rounded overflow-x-auto whitespace-pre-wrap">{{ lines.join('\n') }}</pre>
    </div>
  </main>
</template>
```

- [ ] **Step 2: Smoke verify SSE rendering**

Run: `pnpm dev`
From the index page, drop `/tmp/test.mp4` again (or any new mp4).
Expected:
1. Page navigates to `/player/<hash>`.
2. Status badge shows "running" (yellow).
3. Lines stream into the `<pre>` block, one cue per line, formatted `[mm:ss.fff-mm:ss.fff] text`.
4. After all cues, an extra `[done]` line appears, status badge turns green.

- [ ] **Step 3: Commit**

```bash
git add app/pages/player/[hash].vue
git commit -m "feat(slice-1): player page with EventSource SSE viewer"
```

---

## Task 9: End-to-End Acceptance Test

**Files:** none (manual verification)

- [ ] **Step 1: Clean state**

Run: `rm -rf ~/.subcast`
Run: `pnpm dev`

- [ ] **Step 2: Real-world acceptance run**

1. Take a real ~30-second mp4 (a short clip of someone speaking English clearly).
2. Open http://localhost:3000 in Chrome/Safari.
3. Drag-drop the mp4.
4. Confirm:
   - Upload completes within ~1 second per 100MB.
   - Page navigates to `/player/<hash>`.
   - First cue appears within 30-60 seconds (whisper warm-up).
   - Subsequent cues stream in.
   - `[done]` appears when finished.
   - Status badge turns green.

- [ ] **Step 3: Verify persistence**

Run: `ls -la ~/.subcast/videos/`
Expected: `<hash>.mp4` (≈ original file size)

Run: `sqlite3 ~/.subcast/data.sqlite 'SELECT sha256, original_name, size_bytes FROM videos;'`
Expected: 1 row.

- [ ] **Step 4: Verify lock by re-uploading concurrently**

While transcription is running on tab 1, in tab 2 drag the same file:
Expected: tab 2 uploads OK (same hash, ON CONFLICT updates `last_opened_at`), navigates to player. Player shows error: `connection lost` or "ALREADY_RUNNING" (the SSE rejects with 409 → EventSource fires error). Acceptable behavior for Slice 1.

- [ ] **Step 5: Final commit (slice marker)**

If everything passed:

```bash
git tag slice-1-done -m "Walking Skeleton end-to-end works"
git log --oneline | head -10
```

---

## Notes for the Implementer

- **`nodejs-whisper` model download**: The first invocation of `transcribeOnce` triggers a model download (~150MB for `base`). This blocks the request. Slice 1 accepts this UX pain; F7 (Slice 8) adds a separate `/api/models/pull` endpoint with progress.
- **`Readable.fromWeb` casting**: Some Node typings disagree; the `as never` cast in `upload.post.ts` is a known workaround. Keep an eye out for cleaner types in newer `@types/node`.
- **`event.node.res.write` vs h3 `createEventStream`**: Slice 1 uses raw `res.write` for explicit control over headers. Slice 3 may switch to h3's `createEventStream` once we need clean disconnection semantics for queue cancellation.
- **Why no `<video>` in Slice 1**: Real `<track>` consumption requires a fully written VTT file, which only exists after Whisper completes. Streaming `addCue` via TextTrack API is a Slice 2 concern.
- **Why VTT parser is hand-rolled**: Whisper output is a strict subset of VTT (no styling, no regions). A 30-line parser beats the 80kB `node-webvtt` for our needs. Revisit if user-imported subtitle handling (Slice 6) needs full VTT compliance.

---

## Self-Review Checklist (Author Pre-Handoff)

- [x] Spec coverage: §1 verification criteria, §1 in-scope items all mapped to a task
- [x] §2 storage: only `videos` table touched (per Slice 1 subset)
- [x] §3 SSE: status / cue / done / error implemented; chunk-complete/chunk-retry/warning explicitly deferred
- [x] §4 queue: `isTranscribing` boolean lock as specified
- [x] §5 errors: only Fatal-tier handling
- [x] §7 testing: only `streamSha256` unit-tested; rest manual smoke
- [x] No "TBD" / "TODO" / "implement later" / "similar to" placeholders
- [x] Type consistency: `Cue` type defined once in `vtt.ts`, reused everywhere
- [x] Exact paths, exact commands, expected outputs in every step
