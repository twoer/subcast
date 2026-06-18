/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineEventHandler,
  getQuery,
  createError,
  setResponseHeaders,
  getHeader,
} from 'h3';
import type { H3Event } from 'h3';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { llmQueue } from '../utils/queue';
import { buildInsightMessages } from '../utils/insights';
import { HASH_RE } from '../utils/validate';
import type { SettingsRow, VideoRow } from '../types/db';

const MAX_PROMPT_CHARS = 80_000;

function pickUiLang(event: H3Event): 'zh-CN' | 'en' {
  const al = (getHeader(event, 'accept-language') ?? '').toLowerCase();
  if (al.startsWith('zh')) return 'zh-CN';
  return 'en';
}

function getModel(): string {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('ollama_model') as Pick<SettingsRow, 'value'> | undefined;
  return row?.value ?? 'qwen2.5:7b';
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!HASH_RE.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const video = db
    .prepare('SELECT sha256 FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'sha256'> | undefined;
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

  // Cache-first short-circuit: if a previous successful run wrote insights.json,
  // serve it immediately without re-reading the transcript or doing prompt work.
  const cachePath = join(SUBCAST_PATHS.cache, hash, 'insights.json');
  if (existsSync(cachePath)) {
    try {
      const obj = JSON.parse(readFileSync(cachePath, 'utf-8'));
      res.write(`event: start\ndata: ${JSON.stringify({ taskId: 'cached', model, uiLanguage })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ insights: obj, fromCache: true })}\n\n`);
      res.end();
      return;
    } catch {
      // Parse failure — fall through to regenerate
    }
  }

  // Check prompt length and emit SSE error frame instead of HTTP 413
  // so EventSource clients can read the error code.
  const transcript = readFileSync(origPath, 'utf-8');
  const messages = buildInsightMessages(transcript, uiLanguage);
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (promptChars > MAX_PROMPT_CHARS) {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 'VIDEO_TOO_LONG', message: 'Video too long for AI insights' })}\n\n`);
    res.end();
    return;
  }

  const task = llmQueue.ensureInsightTask(hash, uiLanguage, model);
  await llmQueue.tryStartNext();

  let closed = false;
  event.node.req.on('close', () => {
    closed = true;
  });
  for await (const f of llmQueue.attach(task.id)) {
    if (closed || res.writableEnded) break;
    res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
  }
  if (!res.writableEnded) res.end();
});
