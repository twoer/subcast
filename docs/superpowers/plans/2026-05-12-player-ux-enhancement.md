# Player UX Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add subtitle export (VTT / SRT / TXT / bilingual / multi-file ZIP) and in-list search (highlight + cycle) to the Subcast player page.

**Architecture:** One new Nitro endpoint `/api/export` handling three response shapes (single file / bilingual / ZIP). Pure-frontend search inside the cue list (no network). Format conversion utilities extend existing `server/utils/vtt.ts` and `server/utils/srt.ts`. Two new Vue components mounted from the player page.

**Tech Stack:** Nuxt 4 + Vue 3 + TypeScript (strict), shadcn-vue (Dialog), Tailwind, vitest, `jszip` (already installed) for ZIP streaming. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-05-12-player-ux-enhancement-design.md`

---

## File Structure

**New files**
- `server/api/export.get.ts` — three-mode export endpoint
- `app/components/ExportDialog.vue` — export modal
- `app/components/SearchBar.vue` — cue search bar (collapsed → expanded)
- `server/utils/__tests__/srt.test.ts` — SRT serialize + bilingual SRT tests
- `server/utils/__tests__/vtt.test.ts` — bilingual VTT tests
- `server/utils/__tests__/export.test.ts` — API integration tests

**Modified**
- `server/utils/srt.ts` — add `serializeSrt`, `serializeBilingualSrt`
- `server/utils/vtt.ts` — add `serializeBilingualVtt`
- `app/pages/player/[hash].vue` — toolbar Export button; mount SearchBar above cue list; mount ExportDialog; wire `/` and `Ctrl/Cmd+F` shortcuts; cue list row gets match-highlight class + cue text wraps `<mark>`
- `i18n/locales/en.json`, `i18n/locales/zh-CN.json` — `player.export.*` and `player.search.*` strings
- `README.md` — add `/api/export` to API table; mention export + search in features

---

## Conventions Used in this Plan

- All file paths are absolute from repo root.
- All tests use vitest. Run with `pnpm test`. Tests live in `server/utils/__tests__/` (matches existing `vitest.config.ts` glob `server/**/__tests__/**/*.test.ts`).
- Errors use `createError({ statusCode, statusMessage })` (existing convention).
- Imports use TypeScript path aliases that already work in this repo: `../utils/vtt`, `~/utils/...`, etc.
- Each task ends with a commit. **Commit messages are draft suggestions** — adjust if hooks complain or wording drifts.

---

## Task 1: `serializeSrt` (single-language SRT output)

**Files:**
- Modify: `server/utils/srt.ts` (append at end)
- Create: `server/utils/__tests__/srt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/utils/__tests__/srt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializeSrt } from '../srt';
import type { Cue } from '../vtt';

const c = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('serializeSrt', () => {
  it('emits 1-indexed cues with SRT timestamps and blank-line separator', () => {
    const cues = [
      c(0, 3240, 'Hello world.'),
      c(3240, 6500, 'This is a test.'),
    ];
    expect(serializeSrt(cues)).toBe(
      '1\n' +
      '00:00:00,000 --> 00:00:03,240\n' +
      'Hello world.\n' +
      '\n' +
      '2\n' +
      '00:00:03,240 --> 00:00:06,500\n' +
      'This is a test.\n' +
      '\n',
    );
  });

  it('preserves cue-internal newlines', () => {
    const out = serializeSrt([c(0, 1000, 'line one\nline two')]);
    expect(out).toContain('line one\nline two\n\n');
  });

  it('handles empty input', () => {
    expect(serializeSrt([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- srt.test`
Expected: FAIL with "serializeSrt is not a function" (or import error).

- [ ] **Step 3: Implement `serializeSrt`**

Append to `server/utils/srt.ts`:

```ts
import type { Cue } from './vtt';
// (existing imports / code above)

function msToSrtTs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const k = ms % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(k).padStart(3, '0')}`;
}

export function serializeSrt(cues: readonly Cue[]): string {
  const parts: string[] = [];
  cues.forEach((cue, i) => {
    parts.push(String(i + 1));
    parts.push(`${msToSrtTs(cue.startMs)} --> ${msToSrtTs(cue.endMs)}`);
    parts.push(cue.text);
    parts.push('');
  });
  return parts.length === 0 ? '' : parts.join('\n') + '\n';
}
```

Note: existing `srt.ts` already has its own `tsToMs` helper but no `msToSrtTs` — add the new helper at module top (move existing imports/types around as needed; don't duplicate `import type { Cue }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- srt.test`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/srt.ts server/utils/__tests__/srt.test.ts
git commit -m "feat(srt): add serializeSrt for export"
```

---

## Task 2: `serializeBilingualSrt`

**Files:**
- Modify: `server/utils/srt.ts`
- Modify: `server/utils/__tests__/srt.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `server/utils/__tests__/srt.test.ts`:

```ts
import { serializeBilingualSrt } from '../srt';

describe('serializeBilingualSrt', () => {
  it('stacks original above translated within each cue', () => {
    const original = [c(0, 1000, 'Hello'), c(1000, 2000, 'World')];
    const translated = [c(0, 1000, '你好'), c(1000, 2000, '世界')];
    expect(serializeBilingualSrt(original, translated)).toBe(
      '1\n' +
      '00:00:00,000 --> 00:00:01,000\n' +
      'Hello\n你好\n' +
      '\n' +
      '2\n' +
      '00:00:01,000 --> 00:00:02,000\n' +
      'World\n世界\n' +
      '\n',
    );
  });

  it('throws when cue counts differ', () => {
    expect(() =>
      serializeBilingualSrt([c(0, 1000, 'a')], [c(0, 1000, 'b'), c(1000, 2000, 'c')]),
    ).toThrow(/cue count/i);
  });

  it('throws when timestamps differ', () => {
    expect(() =>
      serializeBilingualSrt([c(0, 1000, 'a')], [c(0, 1500, 'b')]),
    ).toThrow(/timestamp/i);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- srt.test`
Expected: 3 new failures, prior 3 still pass.

- [ ] **Step 3: Implement**

Append to `server/utils/srt.ts`:

```ts
export function serializeBilingualSrt(
  original: readonly Cue[],
  translated: readonly Cue[],
): string {
  if (original.length !== translated.length) {
    throw new Error(`bilingual cue count mismatch: ${original.length} vs ${translated.length}`);
  }
  const parts: string[] = [];
  original.forEach((cue, i) => {
    const t = translated[i]!;
    if (cue.startMs !== t.startMs || cue.endMs !== t.endMs) {
      throw new Error(`bilingual timestamp mismatch at cue ${i}`);
    }
    parts.push(String(i + 1));
    parts.push(`${msToSrtTs(cue.startMs)} --> ${msToSrtTs(cue.endMs)}`);
    parts.push(`${cue.text}\n${t.text}`);
    parts.push('');
  });
  return parts.length === 0 ? '' : parts.join('\n') + '\n';
}
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- srt.test`
Expected: 6 passing tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/srt.ts server/utils/__tests__/srt.test.ts
git commit -m "feat(srt): add serializeBilingualSrt"
```

---

## Task 3: `serializeBilingualVtt`

**Files:**
- Modify: `server/utils/vtt.ts`
- Create: `server/utils/__tests__/vtt.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/utils/__tests__/vtt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializeBilingualVtt } from '../vtt';
import type { Cue } from '../vtt';

const c = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('serializeBilingualVtt', () => {
  it('emits a single VTT with original on top and translated below per cue', () => {
    const original = [c(0, 1000, 'Hello'), c(1000, 2000, 'World')];
    const translated = [c(0, 1000, '你好'), c(1000, 2000, '世界')];
    expect(serializeBilingualVtt(original, translated)).toBe(
      'WEBVTT\n\n' +
      '00:00:00.000 --> 00:00:01.000\n' +
      'Hello\n你好\n\n' +
      '00:00:01.000 --> 00:00:02.000\n' +
      'World\n世界\n',
    );
  });

  it('throws when cue counts differ', () => {
    expect(() =>
      serializeBilingualVtt([c(0, 1000, 'a')], []),
    ).toThrow(/cue count/i);
  });

  it('throws when timestamps differ', () => {
    expect(() =>
      serializeBilingualVtt([c(0, 1000, 'a')], [c(0, 999, 'b')]),
    ).toThrow(/timestamp/i);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- vtt.test`
Expected: FAIL with "serializeBilingualVtt is not exported".

- [ ] **Step 3: Implement**

Append to `server/utils/vtt.ts` (the existing `msToTs` helper is already defined — reuse it):

```ts
export function serializeBilingualVtt(
  original: readonly Cue[],
  translated: readonly Cue[],
): string {
  if (original.length !== translated.length) {
    throw new Error(`bilingual cue count mismatch: ${original.length} vs ${translated.length}`);
  }
  const out: string[] = ['WEBVTT', ''];
  original.forEach((cue, i) => {
    const t = translated[i]!;
    if (cue.startMs !== t.startMs || cue.endMs !== t.endMs) {
      throw new Error(`bilingual timestamp mismatch at cue ${i}`);
    }
    out.push(`${msToTs(cue.startMs)} --> ${msToTs(cue.endMs)}`);
    out.push(`${cue.text}\n${t.text}`);
    out.push('');
  });
  return out.join('\n');
}
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- vtt.test`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/vtt.ts server/utils/__tests__/vtt.test.ts
git commit -m "feat(vtt): add serializeBilingualVtt"
```

---

## Task 4: `/api/export` — single-language mode (VTT / SRT / TXT)

**Files:**
- Create: `server/api/export.get.ts`
- Create: `server/utils/__tests__/export.test.ts`

- [ ] **Step 1: Sketch failing test for single-language VTT**

Create `server/utils/__tests__/export.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub Subcast paths + db before importing the handler.
const tmpRoot = mkdtempSync(join(tmpdir(), 'subcast-export-'));
process.env.SUBCAST_HOME = tmpRoot;

// We use the real export handler via direct invocation. Nitro's h3 event is mocked.
import handler from '../../api/export.get';
import { getDb, SUBCAST_PATHS } from '../db';

function makeEvent(query: Record<string, string>) {
  // Minimal h3-compatible event shape: only context.params + node.req URL used by getQuery.
  const url = '/api/export?' + new URLSearchParams(query).toString();
  const req: any = { url, method: 'GET', headers: {} };
  const res: any = { setHeader: () => {}, getHeader: () => undefined, end: () => {}, write: () => {} };
  return { node: { req, res }, context: {}, _handled: false } as any;
}

const HASH = 'a'.repeat(64);

beforeAll(() => {
  // Create video row + cache vtt file.
  mkdirSync(SUBCAST_PATHS.cache, { recursive: true });
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',
  );
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'zh-CN.vtt'),
    'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n',
  );
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'MyClip.mp4', '.mp4', 0, Date.now(), Date.now());
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/api/export single-language', () => {
  it('returns VTT for original language', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'vtt' });
    const body = await handler(event);
    expect(typeof body).toBe('string');
    expect(body as string).toContain('WEBVTT');
    expect(body as string).toContain('Hello');
  });

  it('returns SRT-formatted body for format=srt', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'srt' });
    const body = await handler(event);
    expect(body as string).toMatch(/^1\n00:00:00,000 --> 00:00:01,000\nHello/);
  });

  it('returns plain text for format=txt', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'txt' });
    expect((await handler(event)) as string).toBe('Hello\n');
  });
});
```

Note: `SUBCAST_HOME` is the env var that `server/utils/db.ts` reads to redirect data root in tests (verify by checking `db.ts`; if absent, add a one-line read of `process.env.SUBCAST_HOME` there — keep that side-fix in this task's commit).

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- export.test`
Expected: FAIL with "Cannot find module '../../api/export.get'".

- [ ] **Step 3: Implement single-lang path**

Create `server/api/export.get.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { parseVtt, serializeVtt } from '../utils/vtt';
import { serializeSrt } from '../utils/srt';

type Format = 'vtt' | 'srt' | 'txt' | 'bilingual-vtt' | 'bilingual-srt';
const VALID_FORMATS: Format[] = ['vtt', 'srt', 'txt', 'bilingual-vtt', 'bilingual-srt'];

function sanitizeBase(name: string | null, hash: string): string {
  const stem = (name ?? '').replace(/\.[^.]+$/, '').trim();
  const safe = stem.replace(/[/\\:*?"<>|]+/g, '_');
  return safe.length > 0 ? safe : `subcast-${hash.slice(0, 8)}`;
}

function extFor(format: Format): string {
  if (format === 'vtt' || format === 'bilingual-vtt') return 'vtt';
  if (format === 'srt' || format === 'bilingual-srt') return 'srt';
  return 'txt';
}

function mimeFor(format: Format): string {
  if (format === 'vtt' || format === 'bilingual-vtt') return 'text/vtt';
  if (format === 'srt' || format === 'bilingual-srt') return 'application/x-subrip';
  return 'text/plain';
}

function readCues(hash: string, lang: string) {
  const path = join(SUBCAST_PATHS.cache, hash, `${lang}.vtt`);
  if (!existsSync(path)) return null;
  return parseVtt(readFileSync(path, 'utf-8'));
}

export default defineEventHandler((event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }
  const format = String(q.format ?? '') as Format;
  if (!VALID_FORMATS.includes(format)) {
    throw createError({ statusCode: 400, statusMessage: 'INVALID_FORMAT' });
  }
  const langs = String(q.langs ?? '').split(',').filter(Boolean);
  if (langs.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'NO_LANGS' });
  }

  const db = getDb();
  const row = db
    .prepare('SELECT original_name FROM videos WHERE sha256 = ?')
    .get(hash) as { original_name: string } | undefined;
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });
  }
  const base = sanitizeBase(row.original_name, hash);

  // Single-language non-bilingual path (this task)
  if (langs.length === 1 && !format.startsWith('bilingual-')) {
    const lang = langs[0]!;
    const cues = readCues(hash, lang);
    if (!cues) {
      throw createError({
        statusCode: 400,
        statusMessage: 'LANG_NOT_CACHED',
        data: { missing: [lang] },
      });
    }
    const body =
      format === 'vtt' ? serializeVtt(cues)
      : format === 'srt' ? serializeSrt(cues)
      : cues.map((c) => c.text).join('\n') + (cues.length > 0 ? '\n' : '');
    setResponseHeader(event, 'Content-Type', `${mimeFor(format)}; charset=utf-8`);
    setResponseHeader(
      event,
      'Content-Disposition',
      `attachment; filename="${base}.${lang}.${extFor(format)}"`,
    );
    return body;
  }

  // Bilingual and ZIP paths are added in subsequent tasks.
  throw createError({ statusCode: 501, statusMessage: 'NOT_IMPLEMENTED' });
});
```

If `server/utils/db.ts` does not honor `process.env.SUBCAST_HOME`, add a 2-line read at the top of `SUBCAST_PATHS` computation so tests can redirect data root. Example diff (apply if needed):

```ts
// At top of db.ts where SUBCAST_PATHS is built:
const SUBCAST_HOME = process.env.SUBCAST_HOME ?? join(homedir(), '.subcast');
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- export.test`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add server/api/export.get.ts server/utils/__tests__/export.test.ts server/utils/db.ts
git commit -m "feat(api): /api/export single-language mode (vtt/srt/txt)"
```

---

## Task 5: `/api/export` — bilingual mode

**Files:**
- Modify: `server/api/export.get.ts`
- Modify: `server/utils/__tests__/export.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `server/utils/__tests__/export.test.ts`:

```ts
describe('/api/export bilingual', () => {
  it('merges original + zh-CN into a single VTT', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,zh-CN',
      format: 'bilingual-vtt',
    });
    const body = (await handler(event)) as string;
    expect(body).toContain('WEBVTT');
    expect(body).toContain('Hello\n你好');
  });

  it('rejects bilingual with langs.length !== 2', async () => {
    const event = makeEvent({ hash: HASH, langs: 'original', format: 'bilingual-vtt' });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400 when requested lang not cached', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,fr-FR',
      format: 'bilingual-vtt',
    });
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- export.test`
Expected: 3 new failures (currently return `NOT_IMPLEMENTED`).

- [ ] **Step 3: Implement bilingual branch**

In `server/api/export.get.ts`, **replace the `throw createError({ statusCode: 501, ... })` line** with this block before it:

```ts
import { serializeBilingualVtt } from '../utils/vtt';
import { serializeBilingualSrt } from '../utils/srt';

// ... inside the handler, after the single-language branch:

if (format.startsWith('bilingual-')) {
  if (langs.length !== 2) {
    throw createError({
      statusCode: 400,
      statusMessage: 'INVALID_BILINGUAL_LANGS',
    });
  }
  const [a, b] = langs as [string, string];
  const cuesA = readCues(hash, a);
  const cuesB = readCues(hash, b);
  const missing = [a, b].filter((l, i) => !(i === 0 ? cuesA : cuesB));
  if (missing.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'LANG_NOT_CACHED',
      data: { missing },
    });
  }
  let body: string;
  try {
    body = format === 'bilingual-vtt'
      ? serializeBilingualVtt(cuesA!, cuesB!)
      : serializeBilingualSrt(cuesA!, cuesB!);
  } catch (err) {
    throw createError({
      statusCode: 422,
      statusMessage: 'BILINGUAL_MISMATCH',
      data: { error: (err as Error).message },
    });
  }
  const ext = extFor(format);
  setResponseHeader(event, 'Content-Type', `${mimeFor(format)}; charset=utf-8`);
  setResponseHeader(
    event,
    'Content-Disposition',
    `attachment; filename="${base}.${a}+${b}.${ext}"`,
  );
  return body;
}
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- export.test`
Expected: 6 passing tests.

- [ ] **Step 5: Commit**

```bash
git add server/api/export.get.ts server/utils/__tests__/export.test.ts
git commit -m "feat(api): /api/export bilingual mode"
```

---

## Task 6: `/api/export` — multi-language ZIP

**Files:**
- Modify: `server/api/export.get.ts`
- Modify: `server/utils/__tests__/export.test.ts`

- [ ] **Step 1: Add failing test**

Append to `server/utils/__tests__/export.test.ts`:

```ts
import JSZip from 'jszip';

describe('/api/export multi-language ZIP', () => {
  it('returns a ZIP containing one SRT per requested lang', async () => {
    const event = makeEvent({
      hash: HASH,
      langs: 'original,zh-CN',
      format: 'srt',
    });
    const body = await handler(event);
    expect(body).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(body as Buffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['MyClip.original.srt', 'MyClip.zh-CN.srt']);
    const en = await zip.files['MyClip.original.srt']!.async('string');
    expect(en).toContain('Hello');
    const zh = await zip.files['MyClip.zh-CN.srt']!.async('string');
    expect(zh).toContain('你好');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- export.test`
Expected: 1 new failure (current handler falls through to `NOT_IMPLEMENTED`).

- [ ] **Step 3: Implement ZIP branch**

In `server/api/export.get.ts`, **replace the remaining `throw createError({ statusCode: 501, ... })`** with this block (after the bilingual branch):

```ts
import JSZip from 'jszip';

// ... after the bilingual branch, the only remaining case is multi-lang + non-bilingual format:

if (langs.length >= 2) {
  // Validate all langs cached up front to produce one clean error.
  const cuesByLang: Record<string, ReturnType<typeof parseVtt>> = {};
  const missing: string[] = [];
  for (const lang of langs) {
    const cues = readCues(hash, lang);
    if (!cues) missing.push(lang);
    else cuesByLang[lang] = cues;
  }
  if (missing.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'LANG_NOT_CACHED',
      data: { missing },
    });
  }
  const zip = new JSZip();
  for (const lang of langs) {
    const cues = cuesByLang[lang]!;
    const body =
      format === 'vtt' ? serializeVtt(cues)
      : format === 'srt' ? serializeSrt(cues)
      : cues.map((c) => c.text).join('\n') + (cues.length > 0 ? '\n' : '');
    zip.file(`${base}.${lang}.${extFor(format)}`, body);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  setResponseHeader(event, 'Content-Type', 'application/zip');
  setResponseHeader(
    event,
    'Content-Disposition',
    `attachment; filename="${base}.subtitles.zip"`,
  );
  return buf;
}

// Should be unreachable.
throw createError({ statusCode: 400, statusMessage: 'INVALID_REQUEST' });
```

Also change the handler signature: replace `defineEventHandler((event) => {` with `defineEventHandler(async (event) => {` (now needs `await` for JSZip).

- [ ] **Step 4: Verify all export tests pass**

Run: `pnpm test -- export.test`
Expected: 7 passing tests total.

- [ ] **Step 5: Commit**

```bash
git add server/api/export.get.ts server/utils/__tests__/export.test.ts
git commit -m "feat(api): /api/export multi-language ZIP"
```

---

## Task 7: `SearchBar.vue`

**Files:**
- Create: `app/components/SearchBar.vue`

- [ ] **Step 1: Write component**

Create `app/components/SearchBar.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-vue-next';

interface CueLike { text: string }

const props = defineProps<{
  cues: CueLike[];
}>();

const emit = defineEmits<{
  (e: 'update:query', value: string): void;
  (e: 'update:matchIdx', value: number | null): void;
}>();

const open = ref(false);
const query = ref('');
const cursor = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const matches = computed<number[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return props.cues
    .map((c, i) => (c.text.toLowerCase().includes(q) ? i : -1))
    .filter((i) => i >= 0);
});

watch(query, (v) => {
  emit('update:query', v);
  cursor.value = 0;
});

watch(matches, (m) => {
  emit('update:matchIdx', m.length === 0 ? null : m[cursor.value % m.length]!);
});

watch(cursor, (c) => {
  if (matches.value.length === 0) return;
  emit('update:matchIdx', matches.value[c % matches.value.length]!);
});

function next() {
  if (matches.value.length === 0) return;
  cursor.value = (cursor.value + 1) % matches.value.length;
}

function prev() {
  if (matches.value.length === 0) return;
  cursor.value = (cursor.value - 1 + matches.value.length) % matches.value.length;
}

async function expand() {
  open.value = true;
  await nextTick();
  inputRef.value?.focus();
}

function close() {
  query.value = '';
  cursor.value = 0;
  open.value = false;
  emit('update:query', '');
  emit('update:matchIdx', null);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

defineExpose({ expand, close, isOpen: () => open.value });
</script>

<template>
  <div class="flex items-center gap-1.5">
    <button
      v-if="!open"
      type="button"
      class="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      :title="$t('player.search.open')"
      @click="expand"
    >
      <Search class="h-4 w-4" />
    </button>
    <div v-else class="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1">
      <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        :placeholder="$t('player.search.placeholder')"
        class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        @keydown="onKey"
      >
      <span class="shrink-0 tabular-nums text-xs text-muted-foreground">
        {{ matches.length === 0 ? '0/0' : `${(cursor % matches.length) + 1}/${matches.length}` }}
      </span>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
        :disabled="matches.length === 0"
        :title="$t('player.search.prev')"
        @click="prev"
      ><ChevronUp class="h-3.5 w-3.5" /></button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
        :disabled="matches.length === 0"
        :title="$t('player.search.next')"
        @click="next"
      ><ChevronDown class="h-3.5 w-3.5" /></button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent"
        :title="$t('player.search.close')"
        @click="close"
      ><X class="h-3.5 w-3.5" /></button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm typecheck`
Expected: No new errors from `SearchBar.vue`. (i18n key warnings are expected here and resolved in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add app/components/SearchBar.vue
git commit -m "feat(player): SearchBar component"
```

---

## Task 8: `ExportDialog.vue`

**Files:**
- Create: `app/components/ExportDialog.vue`

- [ ] **Step 1: Write component**

Create `app/components/ExportDialog.vue`:

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Download } from 'lucide-vue-next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type Format = 'vtt' | 'srt' | 'txt' | 'bilingual-vtt' | 'bilingual-srt';

const props = defineProps<{
  modelValue: boolean;
  hash: string;
  cachedLangs: string[]; // includes 'original' if available
  langLabel: (code: string) => string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const selected = ref<Set<string>>(new Set());
const format = ref<Format>('vtt');

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      // Reset on open: preselect all cached langs in non-bilingual; none in bilingual.
      selected.value = new Set(props.cachedLangs);
      format.value = 'vtt';
    }
  },
);

const isBilingual = computed(() => format.value.startsWith('bilingual-'));

const canDownload = computed(() => {
  const n = selected.value.size;
  return isBilingual.value ? n === 2 : n >= 1;
});

const hint = computed(() => {
  if (selected.value.size === 0) return $t('player.export.hintAtLeastOne');
  if (isBilingual.value && selected.value.size !== 2) return $t('player.export.hintExactly2');
  return '';
});

function toggle(lang: string) {
  const s = new Set(selected.value);
  if (s.has(lang)) s.delete(lang);
  else s.add(lang);
  selected.value = s;
}

function close() {
  emit('update:modelValue', false);
}

function download() {
  if (!canDownload.value) return;
  const langs = Array.from(selected.value).join(',');
  const url = `/api/export?hash=${encodeURIComponent(props.hash)}&langs=${encodeURIComponent(langs)}&format=${format.value}`;
  window.open(url, '_self');
  close();
}

// nuxt-i18n global $t helper isn't auto-available in <script>; use useI18n inline.
import { useI18n } from 'vue-i18n';
const { t: $t } = useI18n();
</script>

<template>
  <Dialog :open="modelValue" @update:open="emit('update:modelValue', $event)">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t('player.export.title') }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-4">
        <div>
          <div class="mb-2 text-sm font-medium">{{ $t('player.export.languages') }}</div>
          <ul class="space-y-1.5 max-h-48 overflow-y-auto">
            <li v-for="lang in cachedLangs" :key="lang" class="flex items-center gap-2">
              <input
                :id="`exp-lang-${lang}`"
                type="checkbox"
                :checked="selected.has(lang)"
                @change="toggle(lang)"
              >
              <label :for="`exp-lang-${lang}`" class="cursor-pointer text-sm">
                {{ langLabel(lang) }}
              </label>
            </li>
          </ul>
        </div>
        <div>
          <div class="mb-2 text-sm font-medium">{{ $t('player.export.format') }}</div>
          <Select v-model="format">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="vtt">VTT</SelectItem>
              <SelectItem value="srt">SRT</SelectItem>
              <SelectItem value="txt">TXT</SelectItem>
              <SelectItem value="bilingual-vtt">Bilingual VTT</SelectItem>
              <SelectItem value="bilingual-srt">Bilingual SRT</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</p>
      </div>
      <DialogFooter>
        <Button variant="secondary" @click="close">{{ $t('common.cancel') }}</Button>
        <Button :disabled="!canDownload" @click="download">
          <Download class="mr-1.5 h-4 w-4" />
          {{ $t('player.export.download') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm typecheck`
Expected: No new errors. (i18n key warnings expected; resolved in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add app/components/ExportDialog.vue
git commit -m "feat(player): ExportDialog component"
```

---

## Task 9: Wire components into player page

**Files:**
- Modify: `app/pages/player/[hash].vue`

This task has the most changes. Do all sub-edits then commit once.

- [ ] **Step 1: Import new components + helpers**

Near the top of the `<script setup>` block (around the existing icon imports), add:

```ts
import ExportDialog from '@/components/ExportDialog.vue';
import SearchBar from '@/components/SearchBar.vue';
import { Search, Download } from 'lucide-vue-next';
```

(The icon import should be merged with the existing `lucide-vue-next` import line — keep the import list sorted/single.)

- [ ] **Step 2: Add search + export state refs**

Below the existing `currentTime` / `currentLang` refs, add:

```ts
const showExport = ref(false);
const searchQuery = ref('');
const searchMatchIdx = ref<number | null>(null);
const searchBarRef = ref<InstanceType<typeof SearchBar> | null>(null);

const cachedLangs = computed<string[]>(() =>
  Object.entries(langStatus.value)
    .filter(([, st]) => st === 'done')
    .map(([lang]) => lang),
);

const searchMatchSet = computed<Set<number>>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return new Set();
  const result = new Set<number>();
  cues.value.forEach((c, i) => {
    if (c.text.toLowerCase().includes(q)) result.add(i);
  });
  return result;
});

function highlightSegments(text: string, q: string): Array<{ t: string; m: boolean }> {
  const query = q.trim();
  if (!query) return [{ t: text, m: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: Array<{ t: string; m: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j < 0) { out.push({ t: text.slice(i), m: false }); break; }
    if (j > i) out.push({ t: text.slice(i, j), m: false });
    out.push({ t: text.slice(j, j + needle.length), m: true });
    i = j + needle.length;
  }
  return out;
}
```

`cues` here refers to the existing computed/ref of the current language's cue array. Verify the actual name at the top of the file (`cuesByLang.value[currentLang.value]`?) and adapt the snippet to use the existing reactive source. If the source isn't already a top-level computed, add one:

```ts
const cues = computed(() => cuesByLang.value[currentLang.value] ?? []);
```

- [ ] **Step 3: Watch `searchMatchIdx` → scroll cue list**

Below the new refs:

```ts
watch(searchMatchIdx, (idx) => {
  if (idx == null) return;
  nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-cue-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
});
```

Ensure `nextTick` is imported from `vue` if not already.

- [ ] **Step 4: Wire global keyboard shortcuts**

Find the existing global keydown handler (the one with `seekBy(-5)`, `seekBy(5)`, etc.). Add **before** the existing `switch` / `if` branches, so they short-circuit when search is the user intent:

```ts
// Inside the global keydown handler:
const tag = (e.target as HTMLElement | null)?.tagName;
const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

if (!inInput && e.key === '/') {
  e.preventDefault();
  searchBarRef.value?.expand();
  return;
}
if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
  e.preventDefault();
  searchBarRef.value?.expand();
  return;
}
```

If the player already has its own "ignore when typing in input" check, integrate this so it doesn't double-up.

- [ ] **Step 5: Add Export button to toolbar + mount ExportDialog**

In the template, find the language `<Select>` in the player toolbar (search for `<SelectTrigger>` near the top of the right pane). Immediately before or after it, add an Export button:

```vue
<button
  type="button"
  class="ml-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-accent hover:text-foreground"
  :title="t('player.export.title')"
  @click="showExport = true"
>
  <Download class="h-4 w-4" />
</button>
```

At the bottom of the template (alongside the existing `<Dialog>` for shortcuts), add:

```vue
<ExportDialog
  v-model="showExport"
  :hash="hash"
  :cached-langs="cachedLangs"
  :lang-label="(code) => langLabel(code, SUPPORTED_LANGS.find(l => l.code === code)?.label ?? code)"
/>
```

`hash` here is whatever ref/route param the page uses to identify the current video — adapt to the actual name (likely `route.params.hash` or a `hash` ref).

- [ ] **Step 6: Mount SearchBar above the cue list**

In the template, find the `<ul class="surface-1 max-h-[40vh] ...">` cue list (around line 921). Insert just above it, inside the same parent section:

```vue
<div class="mb-2 flex items-center justify-end">
  <SearchBar
    ref="searchBarRef"
    :cues="cues"
    @update:query="searchQuery = $event"
    @update:match-idx="searchMatchIdx = $event"
  />
</div>
```

- [ ] **Step 7: Apply highlight class + `<mark>` wrapping in cue list**

Find the cue `<li>` (around line 930). Modify its `:class` binding to add a match-bg class. Locate this part:

```vue
:class="[
  item.idx === activeIdx
    ? 'bg-primary/10 font-medium text-foreground'
    : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground',
  item.cue.quality === 'suspect' && item.idx !== activeIdx ? 'border-warning/40' : '',
]"
```

Add a third entry:

```vue
searchMatchSet.has(item.idx) ? 'bg-yellow-200/30 dark:bg-yellow-500/15' : '',
```

Also add a ring for the current match:

```vue
searchMatchIdx === item.idx ? 'ring-2 ring-yellow-500/60' : '',
```

Then change the cue text rendering. Replace:

```vue
<span class="flex-1">{{ item.cue.text }}</span>
```

with:

```vue
<span class="flex-1">
  <template v-for="(seg, si) in highlightSegments(item.cue.text, searchQuery)" :key="si">
    <mark v-if="seg.m" class="rounded-sm bg-yellow-300/70 px-0.5 text-inherit">{{ seg.t }}</mark>
    <template v-else>{{ seg.t }}</template>
  </template>
</span>
```

- [ ] **Step 8: Manual QA in dev**

Run: `pnpm dev`

Verify in a browser at `http://localhost:3000/player/<hash>` of a video that has at least 2 cached languages:
1. Toolbar shows the Download icon button; clicking opens the export dialog
2. Pick "Original + zh-CN" + format "Bilingual VTT" → file downloads + opens in VLC correctly
3. Pick 2 languages + format "SRT" → ZIP downloads + unzips to 2 SRTs
4. Hit `/` → SearchBar expands & focuses
5. Type a word that appears in the cues → row highlights yellow, current match has yellow ring, list scrolls
6. Hit `Enter` repeatedly → cycles forward; `Shift+Enter` cycles back
7. Hit `Esc` → search closes & highlights disappear
8. Switch language while a search query is active → highlights re-compute on new cue list

If anything misbehaves, fix in this task (do not commit until QA passes).

- [ ] **Step 9: Commit**

```bash
git add app/pages/player/\[hash\].vue
git commit -m "feat(player): wire ExportDialog + SearchBar into player"
```

---

## Task 10: i18n strings

**Files:**
- Modify: `i18n/locales/en.json`
- Modify: `i18n/locales/zh-CN.json`

- [ ] **Step 1: Open `en.json`, locate the existing `player` namespace, add:**

```json
"player": {
  "// existing keys above ...": "",
  "export": {
    "title": "Export Subtitles",
    "languages": "Languages",
    "format": "Format",
    "download": "Download",
    "hintAtLeastOne": "Select at least one language.",
    "hintExactly2": "Bilingual requires exactly 2 languages."
  },
  "search": {
    "open": "Search subtitles",
    "placeholder": "Search...",
    "next": "Next match",
    "prev": "Previous match",
    "close": "Close search"
  }
}
```

Also confirm `common.cancel` exists (used by ExportDialog). If not, add:

```json
"common": { "cancel": "Cancel" }
```

- [ ] **Step 2: Mirror in `zh-CN.json`**

```json
"export": {
  "title": "导出字幕",
  "languages": "语言",
  "format": "格式",
  "download": "下载",
  "hintAtLeastOne": "至少选择一种语言。",
  "hintExactly2": "双语字幕需要恰好选 2 种语言。"
},
"search": {
  "open": "搜索字幕",
  "placeholder": "搜索...",
  "next": "下一个匹配",
  "prev": "上一个匹配",
  "close": "关闭搜索"
}
```

And `common.cancel: "取消"` if missing.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck` and reload the dev server.
Expected: no missing-key warnings in the console when opening ExportDialog / SearchBar.

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/en.json i18n/locales/zh-CN.json
git commit -m "i18n: add export + search strings"
```

---

## Task 11: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `/api/export` to the API endpoint table**

Find the `## API 端点` table. Add:

```markdown
| GET | `/api/export?hash=&langs=&format=` | 下载字幕（vtt/srt/txt/bilingual-vtt/bilingual-srt）；多语言自动 ZIP |
```

- [ ] **Step 2: Add a mention in the features bullet list**

Near the top "## 亮点" section, add a line:

```markdown
- ⬇ **导出 & 搜索** —— 任意语言导出 VTT/SRT/TXT / 双语字幕；播放器内 `/` 或 `Ctrl/Cmd+F` 搜索 cue
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README — export + search"
```

---

## Self-Review Checklist (run before declaring done)

1. **Spec coverage:**
   - Export formats VTT/SRT/TXT → Tasks 1, 4
   - Bilingual VTT/SRT → Tasks 2, 3, 5
   - Multi-file ZIP → Task 6
   - Filename `{name}.{lang}.{ext}` / `{name}.{lang1}+{lang2}.{ext}` / `{name}.subtitles.zip` → Tasks 4, 5, 6
   - Error codes (BAD_HASH, INVALID_FORMAT, INVALID_BILINGUAL_LANGS, LANG_NOT_CACHED, VIDEO_NOT_FOUND, BILINGUAL_MISMATCH) → Tasks 4, 5
   - ExportDialog UI: languages list, format select, exactly-2 rule, disable rules → Task 8
   - SearchBar collapsed/expanded, `/` and `Ctrl+F` shortcuts, Enter/Shift+Enter, Esc → Tasks 7, 9
   - Match row highlight + `<mark>` substring wrapping + scroll-into-view → Task 9
   - i18n keys → Task 10
   - README → Task 11

2. **No placeholders:** Search the plan for "TBD", "TODO", "implement later" — none should exist (verified).

3. **Type consistency:** `Cue` type from `server/utils/vtt.ts` used everywhere; format strings match between API tests, handler, and ExportDialog; SearchBar emit names match player page listeners (`update:query`, `update:matchIdx`).

4. **Acceptance** (spec §9):
   - Tasks 4-6 cover server downloads → ✓
   - Tasks 7, 9 cover `/` & `Ctrl+F` + cycle + Esc → ✓
   - Task 9 covers cross-language search persistence (query stays, matches recompute) → ✓
   - `pnpm typecheck` clean → enforced in Tasks 7, 8, 10

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-player-ux-enhancement.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
