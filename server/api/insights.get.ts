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
import { loadSettings } from '../utils/settings';
import { HASH_RE } from '../utils/validate';
import {
  buildInsightArtifactFingerprint,
  insightSourceRevision,
} from '../utils/artifactFingerprint';
import { readLatestInsightArtifact } from '../utils/artifactStore';
import type { VideoRow } from '../types/db';

const EMERGENCY_TRANSCRIPT_CHARS = 2_000_000;

function pickUiLang(event: H3Event): 'zh-CN' | 'en' {
  const al = (getHeader(event, 'accept-language') ?? '').toLowerCase();
  if (al.startsWith('zh')) return 'zh-CN';
  return 'en';
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

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const res = event.node.res;
  const uiLanguage = pickUiLang(event);
  const model = loadSettings().llmModel;
  if (!model) {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 'MODEL_NOT_CONFIGURED', message: 'No local LLM model is configured' })}\n\n`);
    res.end();
    return;
  }

  const transcript = readFileSync(origPath, 'utf-8');
  const artifactFingerprint = buildInsightArtifactFingerprint({
    videoSha: hash,
    transcript,
    uiLanguage,
    modelId: model,
  });

  const artifact = readLatestInsightArtifact(hash, uiLanguage, artifactFingerprint);
  if (artifact) {
    res.write(`event: start\ndata: ${JSON.stringify({ taskId: 'cached', model, uiLanguage })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ insights: artifact.payload, fromCache: true })}\n\n`);
    res.end();
    return;
  }

  // Legacy compatibility: old builds wrote cache/<sha>/insights.json. Keep
  // reading it so existing caches don't disappear, but new writes go to the
  // fingerprinted artifact store only.
  const legacyCachePath = join(SUBCAST_PATHS.cache, hash, 'insights.json');
  if (existsSync(legacyCachePath)) {
    try {
      const obj = JSON.parse(readFileSync(legacyCachePath, 'utf-8'));
      res.write(`event: start\ndata: ${JSON.stringify({ taskId: 'cached', model, uiLanguage })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ insights: obj, fromCache: true, legacy: true })}\n\n`);
      res.end();
      return;
    } catch {
      // Parse failure — fall through to regenerate
    }
  }

  // Token-aware map/reduce handles normal long transcripts. Keep only a
  // much larger emergency cap to prevent pathological memory use.
  if (transcript.length > EMERGENCY_TRANSCRIPT_CHARS) {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 'VIDEO_TOO_LONG', message: 'Video too long for AI insights' })}\n\n`);
    res.end();
    return;
  }

  const task = llmQueue.ensureInsightTask(hash, uiLanguage, model, insightSourceRevision(transcript));
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
