/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineEventHandler, getQuery, createError, setResponseHeaders, getHeader } from 'h3';
import type { H3Event } from 'h3';
import { getDb, SUBCAST_PATHS } from '../utils/db';
import { parseVtt } from '../utils/vtt';
import { buildInsightMessages, type Insights } from '../utils/insights';
import { logEvent } from '../utils/log';
import { HASH_RE } from '../utils/validate';
import type { SettingsRow, VideoRow } from '../types/db';
import {
  getTaskByHash,
  startTask,
  type InsightTask,
  type InsightTaskError,
} from '../utils/insightTasks';

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
  } catch (err) {
    logEvent({
      level: 'debug',
      event: 'insights_cache_parse_failed',
      hash,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function frame(kind: string, data: unknown): string {
  return `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
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

  const cached = readCachedInsights(hash);
  if (cached) {
    res.write(frame('start', { taskId: 'cached', model, uiLanguage }));
    res.write(frame('done', { insights: cached, fromCache: true }));
    res.end();
    return;
  }

  let task: InsightTask | undefined = getTaskByHash(hash);
  if (!task) {
    const transcript = readFileSync(origPath, 'utf-8');
    const cues = parseVtt(transcript);
    const messages = buildInsightMessages(transcript, uiLanguage);
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    if (promptChars > MAX_PROMPT_CHARS) {
      res.write(frame('error', { code: 'VIDEO_TOO_LONG', message: 'Video too long for AI insights' }));
      res.end();
      return;
    }
    task = startTask({ hash, model, uiLanguage, messages, cues });
  }

  res.write(
    frame('start', {
      taskId: task.id,
      model: task.model,
      uiLanguage: task.uiLanguage,
      status: task.status,
    }),
  );

  if (task.status === 'done' && task.result) {
    res.write(frame('done', { insights: task.result, fromCache: false }));
    res.end();
    return;
  }
  if (task.status === 'error') {
    res.write(frame('error', task.error ?? { code: 'UNKNOWN' }));
    res.end();
    return;
  }
  if (task.status === 'canceled') {
    res.write(frame('error', { code: 'CANCELED' }));
    res.end();
    return;
  }

  // `closed` short-circuits writes once we know the socket is gone: either
  // because we ended the response ourselves (done / error) or because the
  // client disconnected (`req.close`). Without this, EventEmitter callbacks
  // can still fire after res.end() and write to a dead socket.
  let closed = false;
  const write = (chunk: string): void => {
    if (closed || res.writableEnded) return;
    res.write(chunk);
  };
  const end = (): void => {
    if (closed || res.writableEnded) return;
    closed = true;
    res.end();
  };

  // Replay any tokens already accumulated for late subscribers.
  if (task.raw) write(frame('token', { text: task.raw }));

  const onToken = (delta: string) => write(frame('token', { text: delta }));
  const onDone = (insights: Insights) => {
    write(frame('done', { insights, fromCache: false }));
    end();
    cleanup();
  };
  const onError = (err: InsightTaskError) => {
    write(frame('error', err));
    end();
    cleanup();
  };

  const cleanup = (): void => {
    task!.events.off('token', onToken);
    task!.events.off('done', onDone);
    task!.events.off('error', onError);
  };

  task.events.on('token', onToken);
  task.events.on('done', onDone);
  task.events.on('error', onError);

  // Detach generation from client lifetime: only unsubscribe, do not abort.
  event.node.req.on('close', () => {
    closed = true;
    cleanup();
  });
});
