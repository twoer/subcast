# AI Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a player right-pane tab that generates AI summary + chapters from the transcript via local Ollama, streamed token-by-token, cached per video.

**Architecture:** New Nitro SSE endpoint `/api/insights` reads `original.vtt`, builds a prompt, streams Ollama tokens, parses markdown sentinels at completion, snaps chapter timestamps to nearest cue ms, persists `insights.json`. Right pane wraps existing cue list in a `<Tabs>` with a second `InsightsPanel` tab.

**Tech Stack:** Nuxt 4 + Vue 3 + TypeScript strict; existing Ollama wrapper extended with streaming; shadcn-vue Tabs (new add). No new npm dependencies for the core feature.

**Spec:** `docs/superpowers/specs/2026-05-12-ai-insights-design.md`

---

## File Structure

**New**
- `server/api/insights.get.ts` — SSE endpoint
- `server/api/insights/[id].delete.ts` — cancel endpoint
- `server/utils/insights.ts` — prompt + parser + timestamp snap
- `server/utils/__tests__/insights.test.ts` — unit tests (parser/snap/prompt)
- `server/utils/__tests__/insights-api.test.ts` — handler tests with mocked Ollama
- `app/components/InsightsPanel.vue` — Tab content + state machine
- `app/components/ui/tabs/index.ts` — barrel
- `app/components/ui/tabs/Tabs.vue` — shadcn primitive wrapper
- `app/components/ui/tabs/TabsList.vue`
- `app/components/ui/tabs/TabsTrigger.vue`
- `app/components/ui/tabs/TabsContent.vue`

**Modified**
- `server/utils/db.ts` — migration v7 for `insight_tasks` table
- `server/utils/ollama.ts` — add `ollamaStreamChat` helper
- `server/api/cache/list.get.ts` — add `hasInsights: boolean`
- `server/api/cache/[hash].delete.ts` — cascade-delete insights file + table rows
- `app/pages/player/[hash].vue` — wrap right pane in Tabs, mount InsightsPanel
- `i18n/locales/en.json`, `i18n/locales/zh-CN.json` — `player.insights.*`
- `README.md` — `/api/insights` row + feature bullet

---

## Conventions

- Tests under `server/utils/__tests__/`, picked up by `vitest.config.ts` glob.
- Server errors use `createError({ statusCode, statusMessage, data? })`.
- All h3 helpers explicitly imported from `'h3'` (matches T4 of player-ux-enhancement plan).
- Each task ends with a commit. Use the suggested message; adjust if hooks complain.
- Subcast project policy: no decorative comments. Only WHY-comments for non-obvious invariants.

---

## Task 1: Migration v7 — `insight_tasks` table

**Files:**
- Modify: `server/utils/db.ts`

- [ ] **Step 1: Add a `version < 7` migration block at the end of `migrate()`:**

```ts
if (version < 7) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insight_tasks (
      id              TEXT PRIMARY KEY,
      video_sha       TEXT NOT NULL REFERENCES videos(sha256),
      status          TEXT NOT NULL,
      model           TEXT NOT NULL,
      ui_language     TEXT NOT NULL,
      error_msg       TEXT,
      created_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      UNIQUE (video_sha, ui_language)
    );
    CREATE INDEX IF NOT EXISTS idx_insight_status ON insight_tasks(status);
  `);
  db.pragma('user_version = 7');
}
```

- [ ] **Step 2: Sanity test**

Run: `pnpm test` — existing 42 should still pass.
Also run: `node -e "require('better-sqlite3'); const { getDb } = require('./server/utils/db.ts'); console.log(getDb().pragma('user_version'))"` — should print `7`. (If TS import fails, do this manually via `pnpm dev` once and check DB.)

(Skip Step 2 if it's too much friction — the table creation is verified by the next task.)

- [ ] **Step 3: Commit**

```bash
git add server/utils/db.ts
git commit -m "feat(db): migration v7 — insight_tasks table"
```

---

## Task 2: `insights.ts` utility — prompt + parser + snap

**Files:**
- Create: `server/utils/insights.ts`
- Create: `server/utils/__tests__/insights.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/utils/__tests__/insights.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPrompt, parseInsights, snapChapters } from '../insights';
import type { Cue } from '../vtt';

describe('buildPrompt', () => {
  it('includes transcript and language directive', () => {
    const out = buildPrompt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n', 'zh-CN');
    expect(out).toContain('zh-CN');
    expect(out).toContain('Hello');
    expect(out).toContain('## Summary');
    expect(out).toContain('## Chapters');
  });

  it('defaults unknown locale to English instruction', () => {
    const out = buildPrompt('WEBVTT\n', 'fr-FR');
    expect(out.toLowerCase()).toContain('english');
  });
});

describe('parseInsights strict', () => {
  it('parses full template', () => {
    const md = [
      '## Summary',
      '',
      'This is the summary paragraph.',
      '',
      '- Point one',
      '- Point two',
      '',
      '## Chapters',
      '',
      '- [00:00:00] Intro — opening remarks',
      '- [00:03:24] Setup — installing dependencies',
    ].join('\n');
    const out = parseInsights(md);
    expect(out.summary).toBe('This is the summary paragraph.');
    expect(out.summaryBullets).toEqual(['Point one', 'Point two']);
    expect(out.chapters).toHaveLength(2);
    expect(out.chapters[0]).toEqual({ startMs: 0, title: 'Intro', description: 'opening remarks' });
    expect(out.chapters[1]).toEqual({ startMs: 3 * 60_000 + 24_000, title: 'Setup', description: 'installing dependencies' });
  });

  it('accepts MM:SS timestamps too', () => {
    const md = '## Summary\n\nx\n\n## Chapters\n\n- [03:24] Setup\n';
    const out = parseInsights(md);
    expect(out.chapters[0]!.startMs).toBe(204_000);
  });

  it('lenient: missing Chapters section → empty array', () => {
    const md = '## Summary\n\nOnly summary here.\n';
    const out = parseInsights(md);
    expect(out.summary).toBe('Only summary here.');
    expect(out.chapters).toEqual([]);
  });

  it('throws when both summary and chapters fail', () => {
    expect(() => parseInsights('garbage')).toThrow();
  });
});

describe('snapChapters', () => {
  const cue = (s: number, e: number): Cue => ({ startMs: s, endMs: e, text: 'x' });

  it('snaps to nearest cue start', () => {
    const cues = [cue(0, 1000), cue(3500, 4000), cue(10_000, 11_000)];
    const chs = snapChapters(
      [
        { startMs: 100, title: 'a', description: '' },
        { startMs: 3300, title: 'b', description: '' },
        { startMs: 9800, title: 'c', description: '' },
      ],
      cues,
    );
    expect(chs.map((c) => c.startMs)).toEqual([0, 3500, 10_000]);
  });

  it('dedupes adjacent same-startMs chapters (keeps first)', () => {
    const cues = [cue(0, 1000)];
    const chs = snapChapters(
      [
        { startMs: 100, title: 'a', description: 'one' },
        { startMs: 200, title: 'b', description: 'two' },
      ],
      cues,
    );
    expect(chs).toHaveLength(1);
    expect(chs[0]!.title).toBe('a');
  });

  it('drops chapters beyond the last cue', () => {
    const cues = [cue(0, 1000), cue(2000, 3000)];
    const chs = snapChapters(
      [{ startMs: 1000, title: 'ok', description: '' }, { startMs: 99_999, title: 'far', description: '' }],
      cues,
    );
    expect(chs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- insights.test`
Expected: import error / function undefined.

- [ ] **Step 3: Implement `server/utils/insights.ts`**

```ts
import type { Cue } from './vtt';

export interface Chapter {
  startMs: number;
  title: string;
  description: string;
}

export interface Insights {
  summary: string;
  summaryBullets: string[];
  chapters: Chapter[];
}

const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  'en-US': 'English',
};

export function buildPrompt(transcriptVtt: string, uiLang: string): string {
  const langName = LANG_NAMES[uiLang] ?? 'English';
  return [
    'You are summarizing a video transcript. Output strict markdown following the template below. Do not add any other sections, code fences, or commentary.',
    '',
    `LANGUAGE: All output text MUST be in ${langName}.`,
    '',
    'TEMPLATE:',
    '## Summary',
    '',
    '<one paragraph, 100-300 words, written naturally>',
    '',
    '- <key point 1>',
    '- <key point 2>',
    '- <key point 3>',
    '(3 to 5 bullets total)',
    '',
    '## Chapters',
    '',
    '- [HH:MM:SS] <Chapter title> — <one-sentence description>',
    '- [HH:MM:SS] <Chapter title> — <one-sentence description>',
    '(3 to 8 chapters total; use exact timestamps that appear in the transcript)',
    '',
    'TRANSCRIPT:',
    '',
    transcriptVtt,
  ].join('\n');
}

function tsToMs(ts: string): number {
  const parts = ts.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 3) return parts[0]! * 3_600_000 + parts[1]! * 60_000 + parts[2]! * 1000;
  if (parts.length === 2) return parts[0]! * 60_000 + parts[1]! * 1000;
  throw new Error(`bad timestamp: ${ts}`);
}

const SUMMARY_RE = /## Summary\s*\n([\s\S]*?)(?=\n## |$)/i;
const CHAPTERS_RE = /## Chapters\s*\n([\s\S]*?)$/i;
const CHAPTER_LINE_RE = /^- \[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/;

export function parseInsights(md: string): Insights {
  const sumBlock = SUMMARY_RE.exec(md)?.[1]?.trim() ?? '';
  let summary = '';
  const bullets: string[] = [];

  if (sumBlock) {
    const lines = sumBlock.split('\n');
    const paraLines: string[] = [];
    let inBullets = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        inBullets = true;
        bullets.push(trimmed.slice(2).trim());
      } else if (!inBullets && trimmed) {
        paraLines.push(trimmed);
      }
    }
    summary = paraLines.join(' ').trim();
  }

  const chBlock = CHAPTERS_RE.exec(md)?.[1] ?? '';
  const chapters: Chapter[] = [];
  for (const line of chBlock.split('\n')) {
    const m = CHAPTER_LINE_RE.exec(line.trim());
    if (!m) continue;
    try {
      chapters.push({
        startMs: tsToMs(m[1]!),
        title: m[2]!.trim(),
        description: (m[3] ?? '').trim(),
      });
    } catch {
      // skip malformed timestamps
    }
  }

  if (!summary && chapters.length === 0) {
    throw new Error('PARSE_FAILED: neither summary nor chapters extractable');
  }

  return { summary, summaryBullets: bullets, chapters };
}

export function snapChapters(chapters: readonly Chapter[], cues: readonly Cue[]): Chapter[] {
  if (cues.length === 0) return [];
  const lastEnd = cues[cues.length - 1]!.endMs;
  const starts = cues.map((c) => c.startMs);

  function nearest(ms: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! < ms) lo = mid + 1;
      else hi = mid;
    }
    const above = starts[lo]!;
    const below = lo > 0 ? starts[lo - 1]! : above;
    return Math.abs(above - ms) < Math.abs(below - ms) ? above : below;
  }

  const seen = new Set<number>();
  const out: Chapter[] = [];
  for (const ch of chapters) {
    if (ch.startMs > lastEnd) continue;
    const snapped = nearest(ch.startMs);
    if (seen.has(snapped)) continue;
    seen.add(snapped);
    out.push({ ...ch, startMs: snapped });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test -- insights.test`
Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add server/utils/insights.ts server/utils/__tests__/insights.test.ts
git commit -m "feat(insights): prompt + parser + timestamp snap utility"
```

---

## Task 3: Ollama streaming helper

**Files:**
- Modify: `server/utils/ollama.ts`

- [ ] **Step 1: Inspect existing `ollamaChat`**

Read `server/utils/ollama.ts` to see the current non-streaming `ollamaChat(model, prompt, signal)`. The streaming variant returns an `AsyncIterable<string>` of token deltas. Reuse `OLLAMA_URL` and the same error logging.

- [ ] **Step 2: Add `ollamaStreamChat`**

Append to `server/utils/ollama.ts`:

```ts
export async function* ollamaStreamChat(
  model: string,
  prompt: string,
  signal: AbortSignal,
  temperature = 0.3,
): AsyncIterableIterator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      options: { temperature },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OLLAMA_HTTP_${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        const delta = obj.message?.content;
        if (delta) yield delta;
        if (obj.done) return;
      } catch {
        // skip non-JSON heartbeat lines if any
      }
    }
  }
}
```

(Implementation detail: Ollama's `/api/chat` with `stream: true` emits newline-delimited JSON; each line has `message.content` delta plus a final `done: true` line.)

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm test` — existing tests should still pass (this adds an export, doesn't modify existing).
Run: `pnpm typecheck` — clean.

- [ ] **Step 4: Commit**

```bash
git add server/utils/ollama.ts
git commit -m "feat(ollama): add ollamaStreamChat for token streaming"
```

---

## Task 4: `/api/insights` SSE endpoint

**Files:**
- Create: `server/api/insights.get.ts`
- Create: `server/utils/__tests__/insights-api.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/utils/__tests__/insights-api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-insights-'));
  process.env.SUBCAST_HOME = r;
  return { tmpRoot: r };
});

// Mock the streaming util before importing the handler
vi.mock('../ollama', () => ({
  ollamaStreamChat: async function* () {
    yield '## Summary\n\n';
    yield 'Mock summary text.\n\n';
    yield '- Point A\n- Point B\n\n';
    yield '## Chapters\n\n- [00:00:00] Intro — start\n';
  },
}));

/* eslint-disable import/first -- vi.hoisted + vi.mock must precede imports */
import { join } from 'node:path';
import handler from '../../api/insights.get';
import { getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const HASH = 'b'.repeat(64);

function makeEvent(query: Record<string, string>, sentEvents: Array<{ event?: string; data: string }>) {
  const url = '/api/insights?' + new URLSearchParams(query).toString();
  let buffer = '';
  return {
    path: url,
    node: {
      req: { url, method: 'GET', headers: { 'accept-language': 'en' }, on: () => {} },
      res: {
        setHeader: () => {},
        getHeader: () => undefined,
        getHeaderNames: () => [],
        hasHeader: () => false,
        write: (chunk: string) => {
          buffer += chunk;
          let i: number;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const ev = /event: (\w+)/.exec(frame)?.[1];
            const data = /data: (.+)/.exec(frame)?.[1];
            if (data) sentEvents.push({ event: ev, data });
          }
          return true;
        },
        end: () => {},
      },
    },
    context: {},
    _handled: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeAll(() => {
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nHello world.\n',
  );
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'Clip.mp4', '.mp4', 0, Date.now(), Date.now());
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/api/insights SSE', () => {
  it('streams start → tokens → done with parsed insights', async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: HASH }, events);
    await handler(event);

    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('start');
    expect(kinds.filter((k) => k === 'token').length).toBeGreaterThan(0);
    expect(kinds[kinds.length - 1]).toBe('done');

    const done = JSON.parse(events[events.length - 1]!.data);
    expect(done.insights.summary).toContain('Mock summary');
    expect(done.insights.chapters.length).toBeGreaterThanOrEqual(0);
  });

  it('400 on bad hash', async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: 'bad' }, events);
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('409 when original.vtt missing', async () => {
    const events: Array<{ event?: string; data: string }> = [];
    const event = makeEvent({ hash: 'c'.repeat(64) }, events);
    // unknown hash → 404 instead of 409 (no video row)
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- insights-api.test`
Expected: import error.

- [ ] **Step 3: Implement `server/api/insights.get.ts`**

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineEventHandler, getQuery, createError, setResponseHeaders, getHeader } from 'h3';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { parseVtt } from '../utils/vtt';
import { ollamaStreamChat } from '../utils/ollama';
import {
  buildPrompt,
  parseInsights,
  snapChapters,
  type Insights,
} from '../utils/insights';

const MAX_PROMPT_CHARS = 80_000; // ~25k tokens safety margin

function pickUiLang(event: Parameters<typeof getHeader>[0]): 'zh-CN' | 'en' {
  const al = (getHeader(event, 'accept-language') ?? '').toLowerCase();
  if (al.startsWith('zh')) return 'zh-CN';
  return 'en';
}

function getModel(): string {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('ollama_model') as { value: string } | undefined;
  return row?.value ?? 'qwen2.5:7b';
}

function readCachedInsights(hash: string): Insights | null {
  const path = join(SUBCAST_PATHS.cache, hash, 'insights.json');
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as {
      summary: string;
      summaryBullets: string[];
      chapters: Insights['chapters'];
    };
    return { summary: obj.summary, summaryBullets: obj.summaryBullets, chapters: obj.chapters };
  } catch {
    return null;
  }
}

function writeCached(hash: string, insights: Insights, meta: object): void {
  const dir = join(SUBCAST_PATHS.cache, hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'insights.json'),
    JSON.stringify({ ...insights, _meta: meta }, null, 2),
  );
}

function frame(kind: string, data: unknown): string {
  return `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const video = db.prepare('SELECT sha256 FROM videos WHERE sha256 = ?').get(hash);
  if (!video) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  const origPath = join(SUBCAST_PATHS.cache, hash, 'original.vtt');
  if (!existsSync(origPath)) {
    throw createError({ statusCode: 409, statusMessage: 'NO_ORIGINAL_VTT' });
  }

  const uiLanguage = pickUiLang(event);
  const model = getModel();

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const res = event.node.res;

  // Cache hit fast path
  const cached = readCachedInsights(hash);
  if (cached) {
    res.write(frame('start', { taskId: 'cached', model, uiLanguage }));
    res.write(frame('done', { insights: cached, fromCache: true }));
    res.end();
    return;
  }

  // Build prompt
  const transcript = readFileSync(origPath, 'utf-8');
  const cues = parseVtt(transcript);
  const prompt = buildPrompt(transcript, uiLanguage);
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.write(frame('error', { code: 'VIDEO_TOO_LONG', message: 'Video too long for AI insights' }));
    res.end();
    return;
  }

  // Track task
  const taskId = randomUUID();
  db.prepare(
    `INSERT OR REPLACE INTO insight_tasks (id, video_sha, status, model, ui_language, created_at)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).run(taskId, hash, model, uiLanguage, Date.now());

  const ac = new AbortController();
  event.node.req.on('close', () => ac.abort());

  res.write(frame('start', { taskId, model, uiLanguage }));

  let raw = '';
  let attempt = 0;
  const TEMPS = [0.3, 0.0];

  while (attempt < TEMPS.length) {
    raw = '';
    try {
      for await (const delta of ollamaStreamChat(model, prompt, ac.signal, TEMPS[attempt]!)) {
        raw += delta;
        if (attempt === 0) res.write(frame('token', { text: delta }));
      }
      const parsed = parseInsights(raw);
      const snapped = { ...parsed, chapters: snapChapters(parsed.chapters, cues) };
      writeCached(hash, snapped, {
        ollamaModel: model,
        uiLanguage,
        originalCueCount: cues.length,
        generatedAt: Date.now(),
        rawMarkdown: raw,
      });
      db.prepare(
        `UPDATE insight_tasks SET status='done', completed_at=? WHERE id=?`,
      ).run(Date.now(), taskId);
      res.write(frame('done', { insights: snapped, fromCache: false }));
      res.end();
      return;
    } catch (err) {
      attempt++;
      if (ac.signal.aborted) {
        db.prepare(`UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`).run(Date.now(), taskId);
        res.end();
        return;
      }
      if (attempt >= TEMPS.length) {
        // final fail — keep raw on disk for inspection
        const dir = join(SUBCAST_PATHS.cache, hash);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'insights.json.raw.txt'), raw);
        db.prepare(`UPDATE insight_tasks SET status='error', error_msg=?, completed_at=? WHERE id=?`).run(
          (err as Error).message,
          Date.now(),
          taskId,
        );
        res.write(frame('error', { code: 'PARSE_FAILED', message: (err as Error).message }));
        res.end();
        return;
      }
    }
  }
});
```

- [ ] **Step 4: Verify tests**

Run: `pnpm test -- insights-api.test`
Expected: 3 tests pass.

Also run: `pnpm test` — all (44+) tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/api/insights.get.ts server/utils/__tests__/insights-api.test.ts
git commit -m "feat(api): /api/insights SSE endpoint"
```

---

## Task 5: `/api/insights/:id` DELETE — cancel

**Files:**
- Create: `server/api/insights/[id].delete.ts`

The endpoint marks the task canceled in DB. Actual stream abort is driven by the client closing the SSE connection (`req.on('close')` in Task 4). This endpoint is for explicit cancellation from a different request — though in practice the SSE connection close is the primary cancel path. We still expose it for symmetry with translate.

- [ ] **Step 1: Implement**

Create `server/api/insights/[id].delete.ts`:

```ts
import { defineEventHandler, getRouterParam, createError } from 'h3';
import { getDb } from '../../utils/db';

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'BAD_ID' });

  const db = getDb();
  const row = db
    .prepare('SELECT status FROM insight_tasks WHERE id = ?')
    .get(id) as { status: string } | undefined;
  if (!row) throw createError({ statusCode: 404, statusMessage: 'TASK_NOT_FOUND' });

  if (row.status === 'running' || row.status === 'queued') {
    db.prepare(`UPDATE insight_tasks SET status='canceled', completed_at=? WHERE id=?`).run(Date.now(), id);
  }
  return { ok: true };
});
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck` — clean.

- [ ] **Step 3: Commit**

```bash
git add server/api/insights/\[id\].delete.ts
git commit -m "feat(api): /api/insights/:id DELETE cancel endpoint"
```

---

## Task 6: Cache integration

**Files:**
- Modify: `server/api/cache/list.get.ts`
- Modify: `server/api/cache/[hash].delete.ts`

- [ ] **Step 1: Add `hasInsights` to cache list**

In `server/api/cache/list.get.ts`, inside the items push, add a check:

```ts
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// inside loop:
const hasInsights = existsSync(join(SUBCAST_PATHS.cache, r.sha256, 'insights.json'));
items.push({
  // ... existing fields
  hasInsights,
});
```

Also update the `CacheEntry` interface at the top to include `hasInsights: boolean`.

- [ ] **Step 2: Cascade delete in `[hash].delete.ts`**

Find the existing DELETE cascade lines (the `db.prepare('DELETE FROM ...')` calls). Add:

```ts
db.prepare(`DELETE FROM insight_tasks WHERE video_sha = ?`).run(hash);
```

(The on-disk `insights.json` and `insights.json.raw.txt` are inside `cacheDir` and already removed by the existing `rm(cacheDir, { recursive: true })` call.)

- [ ] **Step 3: Verify**

Run: `pnpm test` — should still pass.
Run: `pnpm typecheck` — clean.

- [ ] **Step 4: Commit**

```bash
git add server/api/cache/list.get.ts server/api/cache/\[hash\].delete.ts
git commit -m "feat(cache): track insights presence and cascade delete"
```

---

## Task 7: shadcn-vue Tabs

**Files:**
- Create: `app/components/ui/tabs/Tabs.vue`
- Create: `app/components/ui/tabs/TabsList.vue`
- Create: `app/components/ui/tabs/TabsTrigger.vue`
- Create: `app/components/ui/tabs/TabsContent.vue`
- Create: `app/components/ui/tabs/index.ts`

The project uses `reka-ui` (already in deps) which is the Vue port of Radix primitives. shadcn-vue Tabs wraps reka-ui's TabsRoot/List/Trigger/Content with styled classes.

- [ ] **Step 1: Create the four wrappers**

`app/components/ui/tabs/Tabs.vue`:

```vue
<script setup lang="ts">
import { TabsRoot, type TabsRootProps, type TabsRootEmits, useForwardPropsEmits } from 'reka-ui';

const props = defineProps<TabsRootProps>();
const emits = defineEmits<TabsRootEmits>();
const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <TabsRoot v-bind="forwarded">
    <slot />
  </TabsRoot>
</template>
```

`app/components/ui/tabs/TabsList.vue`:

```vue
<script setup lang="ts">
import { TabsList, type TabsListProps } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<TabsListProps & { class?: string }>();
</script>

<template>
  <TabsList
    v-bind="$attrs"
    :class="cn('inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground', props.class)"
  >
    <slot />
  </TabsList>
</template>
```

`app/components/ui/tabs/TabsTrigger.vue`:

```vue
<script setup lang="ts">
import { TabsTrigger, type TabsTriggerProps, useForwardProps } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<TabsTriggerProps & { class?: string }>();
const forwarded = useForwardProps(props);
</script>

<template>
  <TabsTrigger
    v-bind="forwarded"
    :class="cn('inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm', props.class)"
  >
    <slot />
  </TabsTrigger>
</template>
```

`app/components/ui/tabs/TabsContent.vue`:

```vue
<script setup lang="ts">
import { TabsContent, type TabsContentProps, useForwardProps } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = defineProps<TabsContentProps & { class?: string }>();
const forwarded = useForwardProps(props);
</script>

<template>
  <TabsContent
    v-bind="forwarded"
    :class="cn('mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', props.class)"
  >
    <slot />
  </TabsContent>
</template>
```

`app/components/ui/tabs/index.ts`:

```ts
export { default as Tabs } from './Tabs.vue';
export { default as TabsList } from './TabsList.vue';
export { default as TabsTrigger } from './TabsTrigger.vue';
export { default as TabsContent } from './TabsContent.vue';
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck` — clean.

- [ ] **Step 3: Commit**

```bash
git add app/components/ui/tabs
git commit -m "feat(ui): add shadcn-vue Tabs components"
```

---

## Task 8: `InsightsPanel.vue`

**Files:**
- Create: `app/components/InsightsPanel.vue`

This component manages the state machine (empty / generating / ready / outdated / error), drives the SSE connection, and renders summary + chapters.

- [ ] **Step 1: Implement**

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { Sparkles, Play, RotateCcw, X as XIcon, AlertCircle } from 'lucide-vue-next';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';

interface Chapter { startMs: number; title: string; description: string }
interface Insights {
  summary: string;
  summaryBullets: string[];
  chapters: Chapter[];
  _meta?: { ollamaModel: string; uiLanguage: string; originalCueCount: number; generatedAt: number };
}

const props = defineProps<{
  hash: string;
  cueCount: number;
  currentOllamaModel: string;
}>();

const emit = defineEmits<{
  (e: 'seek', ms: number): void;
}>();

type State = 'empty' | 'generating' | 'ready' | 'outdated' | 'error';

const { t, locale } = useI18n();
const state = ref<State>('empty');
const errorCode = ref<string | null>(null);
const streamedText = ref<string>('');
const insights = ref<Insights | null>(null);
let es: EventSource | null = null;
let currentTaskId: string | null = null;

const isOutdated = computed(() => {
  const m = insights.value?._meta;
  if (!m) return false;
  return m.ollamaModel !== props.currentOllamaModel || m.originalCueCount !== props.cueCount;
});

onMounted(() => {
  fetchInitial();
});

watch(() => locale.value, () => {
  // UI language change: clear local cache view; backend's cache key is by ui_language so it'll regen on next click
  if (insights.value && insights.value._meta?.uiLanguage !== locale.value) {
    insights.value = null;
    state.value = 'empty';
  }
});

onBeforeUnmount(() => {
  closeStream();
});

async function fetchInitial() {
  // Probe via cache list — cheap check for hasInsights
  try {
    const res = await $fetch<{ items: Array<{ sha256: string; hasInsights?: boolean }> }>('/api/cache/list');
    const entry = res.items.find((i) => i.sha256 === props.hash);
    if (entry?.hasInsights) {
      // Trigger a cache-hit SSE which returns immediately with `done`
      startStream(true);
    }
  } catch {
    // ignore
  }
}

function startStream(silent = false) {
  closeStream();
  if (!silent) {
    state.value = 'generating';
    streamedText.value = '';
    errorCode.value = null;
  }
  es = new EventSource(`/api/insights?hash=${encodeURIComponent(props.hash)}`);
  es.addEventListener('start', (e) => {
    if (!silent) state.value = 'generating';
    const data = JSON.parse((e as MessageEvent).data);
    currentTaskId = data.taskId;
  });
  es.addEventListener('token', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    streamedText.value += data.text;
  });
  es.addEventListener('done', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    insights.value = data.insights;
    state.value = isOutdated.value ? 'outdated' : 'ready';
    closeStream();
  });
  es.addEventListener('error', (e) => {
    if (es?.readyState === EventSource.CLOSED) return;
    const data = (e as MessageEvent).data ? JSON.parse((e as MessageEvent).data) : { code: 'NETWORK' };
    errorCode.value = data.code ?? 'NETWORK';
    state.value = 'error';
    closeStream();
  });
}

function closeStream() {
  if (es) {
    es.close();
    es = null;
  }
}

async function cancel() {
  if (currentTaskId) {
    try {
      await $fetch(`/api/insights/${currentTaskId}`, { method: 'DELETE' });
    } catch {
      // ignore
    }
  }
  closeStream();
  state.value = 'empty';
  streamedText.value = '';
  currentTaskId = null;
}

function regenerate() {
  insights.value = null;
  startStream();
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
</script>

<template>
  <div class="flex h-full flex-col gap-3 overflow-y-auto px-1">
    <!-- empty state -->
    <div v-if="state === 'empty'" class="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
      <Sparkles class="h-10 w-10 text-muted-foreground/50" />
      <p class="text-sm text-muted-foreground">{{ t('player.insights.emptyHint') }}</p>
      <Button size="sm" @click="startStream()">
        <Sparkles class="mr-1.5 h-4 w-4" />
        {{ t('player.insights.generate') }}
      </Button>
    </div>

    <!-- generating state: show streaming raw markdown -->
    <div v-else-if="state === 'generating'" class="flex flex-1 flex-col gap-3">
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-2 text-sm text-muted-foreground">
          <span class="relative flex h-2 w-2">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/50" />
            <span class="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          {{ t('player.insights.generating') }}
        </span>
        <Button size="sm" variant="ghost" @click="cancel">
          <XIcon class="mr-1 h-3.5 w-3.5" />
          {{ t('player.insights.cancel') }}
        </Button>
      </div>
      <pre class="whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-sans text-sm leading-relaxed">{{ streamedText }}</pre>
    </div>

    <!-- ready / outdated state -->
    <div v-else-if="(state === 'ready' || state === 'outdated') && insights" class="flex flex-1 flex-col gap-4">
      <div v-if="state === 'outdated'" class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
        <AlertCircle class="h-4 w-4 shrink-0 text-warning" />
        <div class="flex-1">{{ t('player.insights.outdatedHint') }}</div>
        <Button size="sm" variant="ghost" @click="regenerate">
          <RotateCcw class="mr-1 h-3.5 w-3.5" />
          {{ t('player.insights.regenerate') }}
        </Button>
      </div>

      <section>
        <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{{ t('player.insights.summarySection') }}</h3>
        <p class="text-sm leading-relaxed">{{ insights.summary }}</p>
        <ul v-if="insights.summaryBullets.length > 0" class="mt-3 space-y-1.5 text-sm">
          <li v-for="(b, i) in insights.summaryBullets" :key="i" class="flex gap-2">
            <span class="text-muted-foreground">•</span>
            <span>{{ b }}</span>
          </li>
        </ul>
      </section>

      <section v-if="insights.chapters.length > 0">
        <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{{ t('player.insights.chaptersSection') }}</h3>
        <ul class="space-y-2">
          <li
            v-for="(ch, i) in insights.chapters"
            :key="i"
            class="cursor-pointer rounded-md border border-border/40 bg-muted/20 p-2.5 hover:bg-accent"
            @click="emit('seek', ch.startMs)"
          >
            <div class="flex items-baseline gap-2">
              <span class="shrink-0 font-mono text-xs tabular-nums text-primary">{{ fmtTime(ch.startMs) }}</span>
              <span class="font-medium">{{ ch.title }}</span>
            </div>
            <p v-if="ch.description" class="mt-1 text-xs text-muted-foreground">{{ ch.description }}</p>
          </li>
        </ul>
      </section>

      <div class="flex justify-end pt-2">
        <Button size="sm" variant="ghost" @click="regenerate">
          <RotateCcw class="mr-1 h-3.5 w-3.5" />
          {{ t('player.insights.regenerate') }}
        </Button>
      </div>
    </div>

    <!-- error state -->
    <div v-else-if="state === 'error'" class="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
      <AlertCircle class="h-10 w-10 text-destructive/70" />
      <p class="text-sm text-muted-foreground">{{ t(`player.insights.errors.${errorCode}`, t('player.insights.errors.fallback')) }}</p>
      <Button size="sm" @click="startStream()">
        <Play class="mr-1.5 h-4 w-4" />
        {{ t('player.insights.retry') }}
      </Button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean (i18n key warnings expected; resolved in Task 10).

- [ ] **Step 3: Commit**

```bash
git add app/components/InsightsPanel.vue
git commit -m "feat(player): InsightsPanel component"
```

---

## Task 9: Player page wiring — wrap right pane in Tabs

**Files:**
- Modify: `app/pages/player/[hash].vue`

This change wraps the existing cue list + SearchBar block (the right column) in a `<Tabs>` and adds a second tab for `InsightsPanel`. SearchBar lives inside Tab 1; Tab 2 is purely InsightsPanel.

- [ ] **Step 1: Import additions**

Near existing imports:

```ts
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import InsightsPanel from '@/components/InsightsPanel.vue';
import { Sparkles } from 'lucide-vue-next';
```

- [ ] **Step 2: Add ollamaModel ref (for InsightsPanel prop)**

Near other refs:

```ts
const ollamaModel = ref<string>('qwen2.5:7b');
onMounted(async () => {
  try {
    const s = await $fetch<{ ollamaModel?: string }>('/api/settings');
    if (s.ollamaModel) ollamaModel.value = s.ollamaModel;
  } catch { /* ignore */ }
});
```

(If `onMounted` and `$fetch` are not already imported/available, add as needed. `onMounted` from `vue`. `$fetch` is Nuxt auto-import.)

- [ ] **Step 3: Add seek-from-chapter handler**

```ts
function seekToMs(ms: number) {
  const v = videoRef.value;
  if (!v) return;
  v.currentTime = ms / 1000;
  v.play().catch(() => {});
}
```

- [ ] **Step 4: Wrap the right column in Tabs**

Find the right-pane `<section>` that contains the SearchBar + cue list `<ul>`. Wrap them so the structure becomes:

```vue
<section class="...">
  <!-- header with lang select + Export button stays OUTSIDE the Tabs -->
  <Tabs default-value="subtitles" class="flex flex-1 flex-col">
    <TabsList class="grid w-full grid-cols-2">
      <TabsTrigger value="subtitles">{{ t('player.subtitles') }}</TabsTrigger>
      <TabsTrigger value="insights">
        <Sparkles class="mr-1 h-3.5 w-3.5" />
        {{ t('player.insights.tabLabel') }}
      </TabsTrigger>
    </TabsList>
    <TabsContent value="subtitles" class="flex flex-1 flex-col min-h-0">
      <!-- existing SearchBar wrapper + ul cue list go here unchanged -->
    </TabsContent>
    <TabsContent value="insights" class="flex flex-1 min-h-0">
      <InsightsPanel
        :hash="hash"
        :cue-count="cuesByLang.original?.length ?? 0"
        :current-ollama-model="ollamaModel"
        @seek="seekToMs"
      />
    </TabsContent>
  </Tabs>
</section>
```

Adjust class names to match the existing layout's flex/height semantics. The cue list `<ul>` already has `xl:max-h-none xl:min-h-0` etc.; preserve those.

- [ ] **Step 5: Manual QA**

Run: `pnpm dev`.

In a browser:
1. Open a video that already has `original.vtt` cached (or wait for transcription)
2. Right pane shows Tabs with `字幕` and `✨ AI 总结`
3. Default tab = `字幕`, SearchBar + cue list look unchanged
4. Click `✨ AI 总结` tab → empty state with Generate button
5. Click Generate → tokens stream in (`<pre>` shows partial markdown)
6. After ~30-60s → structured summary + chapters list rendered
7. Click a chapter → video seeks to that timestamp
8. Reopen the page → AI tab content loads instantly from cache

If any of these fail, fix in this task before committing.

- [ ] **Step 6: Commit**

```bash
git add app/pages/player/\[hash\].vue
git commit -m "feat(player): wrap right pane in Tabs, mount InsightsPanel"
```

---

## Task 10: i18n strings

**Files:**
- Modify: `i18n/locales/en.json`
- Modify: `i18n/locales/zh-CN.json`

- [ ] **Step 1: Add `player.insights.*` to en.json**

Under `"player": { ... }`:

```json
"insights": {
  "tabLabel": "AI Insights",
  "emptyHint": "No insights yet. Generate a summary and chapters from the transcript using your local Ollama.",
  "generate": "Generate AI insights",
  "generating": "Generating...",
  "cancel": "Cancel",
  "regenerate": "Regenerate",
  "retry": "Try again",
  "summarySection": "Summary",
  "chaptersSection": "Chapters",
  "outdatedHint": "Insights were generated with outdated settings (model or transcript changed).",
  "errors": {
    "OLLAMA_UNREACHABLE": "Ollama is not reachable. Make sure it's running.",
    "MODEL_NOT_PULLED": "The Ollama model is not pulled yet.",
    "VIDEO_TOO_LONG": "Video is too long for AI insights with the current model.",
    "PARSE_FAILED": "The AI output couldn't be parsed. Please try again.",
    "NETWORK": "Lost connection while generating insights.",
    "fallback": "Failed to generate insights. Please try again."
  }
}
```

- [ ] **Step 2: Mirror in zh-CN.json**

```json
"insights": {
  "tabLabel": "AI 总结",
  "emptyHint": "暂未生成。使用本地 Ollama 从转写文本生成总结与章节。",
  "generate": "生成 AI 总结",
  "generating": "生成中...",
  "cancel": "取消",
  "regenerate": "重新生成",
  "retry": "再试一次",
  "summarySection": "全文总结",
  "chaptersSection": "章节",
  "outdatedHint": "总结基于已变更的设置生成（模型或转写文本已变）。",
  "errors": {
    "OLLAMA_UNREACHABLE": "Ollama 未运行，请确认本地服务已启动。",
    "MODEL_NOT_PULLED": "Ollama 模型尚未拉取。",
    "VIDEO_TOO_LONG": "视频太长，当前模型无法生成 AI 总结。",
    "PARSE_FAILED": "AI 输出无法解析，请重试。",
    "NETWORK": "生成期间网络中断。",
    "fallback": "生成失败，请重试。"
  }
}
```

- [ ] **Step 3: Verify JSON valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('i18n/locales/en.json'));JSON.parse(require('fs').readFileSync('i18n/locales/zh-CN.json'));console.log('ok')"
```

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/en.json i18n/locales/zh-CN.json
git commit -m "i18n: add AI insights strings"
```

---

## Task 11: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `/api/insights` to API table**

In the `## API 端点` table, add (before `/api/health`):

```markdown
| GET | `/api/insights?hash=` | SSE：流式生成 AI 总结 + 章节；命中缓存直接发 done 事件 |
| DELETE | `/api/insights/:id` | 取消进行中的 AI insights 任务 |
```

- [ ] **Step 2: Add feature bullet**

In `## 亮点`, add (last bullet):

```markdown
- ✨ **AI 总结 + 章节** —— 播放器内一键生成；本地 Ollama 流式输出；章节可点击跳转
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README — document AI insights feature"
```

---

## Self-Review Checklist

1. **Spec coverage**:
   - `/api/insights` SSE → Task 4 ✓
   - cancel endpoint → Task 5 ✓
   - prompt + parser + snap → Task 2 ✓
   - Ollama streaming → Task 3 ✓
   - DB migration → Task 1 ✓
   - Cache integration → Task 6 ✓
   - Tabs UI → Tasks 7, 9 ✓
   - InsightsPanel state machine → Task 8 ✓
   - i18n → Task 10 ✓
   - README → Task 11 ✓
   - Outdated banner / regenerate → Task 8 (`isOutdated` computed + banner) ✓
   - UI language change clears cache → Task 8 (`watch(locale)`) ✓
   - Cancel via DELETE → Tasks 5, 8 ✓

2. **No placeholders**: searched — none.

3. **Type consistency**: `Insights` / `Chapter` defined in `insights.ts` (Task 2), referenced in Tasks 4, 8.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-ai-insights.md`. The previous slice (player-ux-enhancement) used Subagent-Driven Development successfully — proceed with the same approach for this plan.
