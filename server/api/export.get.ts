/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3';
import JSZip from 'jszip';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { parseVtt, serializeVtt, serializeBilingualVtt } from '../utils/vtt';
import { serializeSrt, serializeBilingualSrt } from '../utils/srt';
import { HASH_RE } from '../utils/validate';
import type { VideoRow } from '../types/db';

type Format = 'vtt' | 'srt' | 'txt' | 'bilingual-vtt' | 'bilingual-srt';
const VALID_FORMATS: Format[] = ['vtt', 'srt', 'txt', 'bilingual-vtt', 'bilingual-srt'];
const LANG_RE = /^[a-zA-Z0-9_-]{1,32}$/;

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

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!HASH_RE.test(hash)) {
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
  if (new Set(langs).size !== langs.length) {
    throw createError({
      statusCode: 400,
      statusMessage: 'DUPLICATE_LANGS',
      data: { langs },
    });
  }
  for (const lang of langs) {
    if (!LANG_RE.test(lang)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'BAD_LANG',
        data: { bad: lang },
      });
    }
  }

  const db = getDb();
  const row = db
    .prepare('SELECT original_name, display_name FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'original_name' | 'display_name'> | undefined;
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });
  }
  // Prefer the user-set display name (rename feature) over the raw upload
  // filename — that's what the user sees in the library and recognizes.
  const base = sanitizeBase(row.display_name ?? row.original_name, hash);

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
      : cues.map((c) => c.text).join('\n') + '\n';
    setResponseHeader(event, 'Content-Type', `${mimeFor(format)}; charset=utf-8`);
    setResponseHeader(
      event,
      'Content-Disposition',
      `attachment; filename="${base}.${lang}.${extFor(format)}"`,
    );
    return body;
  }

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
    const missing: string[] = [];
    if (!cuesA) missing.push(a);
    if (!cuesB) missing.push(b);
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
    setResponseHeader(event, 'Content-Type', `${mimeFor(format)}; charset=utf-8`);
    setResponseHeader(
      event,
      'Content-Disposition',
      `attachment; filename="${base}.${a}+${b}.${extFor(format)}"`,
    );
    return body;
  }

  if (langs.length >= 2) {
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
        : cues.map((c) => c.text).join('\n') + '\n';
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

  throw createError({ statusCode: 400, statusMessage: 'INVALID_REQUEST' });
});
