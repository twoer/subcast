// Nitro auto-imports getDb / SUBCAST_PATHS from server/utils/db.ts.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile as writeFileAsync } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';

import { parseSubtitleByExt } from '../utils/srt';
import { serializeVtt } from '../utils/vtt';

const VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'];
const SUB_EXT = ['.srt', '.vtt', '.ass'];
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
  if (!VIDEO_EXT.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: `unsupported ext ${ext}` });
  }

  // Optional companion subtitle (F1 伴生字幕检测)
  const subFile = formData.get('subtitle');
  let subExt: string | null = null;
  if (subFile instanceof File) {
    subExt = extname(subFile.name).toLowerCase();
    if (!SUB_EXT.includes(subExt)) {
      throw createError({
        statusCode: 400,
        statusMessage: `unsupported subtitle ext ${subExt}`,
      });
    }
    if (subFile.size > 5 * 1024 * 1024) {
      throw createError({ statusCode: 400, statusMessage: 'subtitle > 5MB' });
    }
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

  let imported = false;
  if (subFile instanceof File && subExt) {
    const subText = await subFile.text();
    const cues = parseSubtitleByExt(subText, subExt);
    if (cues.length === 0) {
      throw createError({
        statusCode: 400,
        statusMessage: 'subtitle file parsed empty',
      });
    }
    const cacheDir = join(SUBCAST_PATHS.cache, sha);
    await mkdir(cacheDir, { recursive: true });
    await writeFileAsync(
      join(cacheDir, 'original.vtt'),
      serializeVtt(cues),
      'utf8',
    );
    await writeFileAsync(
      join(cacheDir, 'meta.json'),
      JSON.stringify({
        sha256: sha,
        ext,
        importedAt: now,
        importedFrom: subFile.name,
        cuesCount: cues.length,
        model: 'imported',
      }, null, 2),
      'utf8',
    );

    // Mark as transcribed so /api/transcribe?hash= short-circuits to cache.
    // Faux task + chunks rows let the existing attach() logic replay these
    // cues without special-casing import.
    const taskId = randomUUID();
    db.prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, total_chunks, done_chunks, created_at, completed_at)
       VALUES (?, ?, 'completed', 'imported', 1, 1, ?, ?)`,
    ).run(taskId, sha, now, now);
    db.prepare(
      `INSERT INTO chunks (task_id, chunk_idx, start_ms, end_ms, cues_json, quality, retry_count)
       VALUES (?, 0, ?, ?, ?, 'ok', 0)`,
    ).run(
      taskId,
      cues[0]!.startMs,
      cues[cues.length - 1]!.endMs,
      JSON.stringify(cues),
    );
    db.prepare(
      `INSERT INTO subtitles (video_sha, lang, kind, cues_count, completed_at)
       VALUES (?, 'original', 'imported', ?, ?)
       ON CONFLICT(video_sha, lang) DO UPDATE SET
         kind = excluded.kind,
         cues_count = excluded.cues_count,
         completed_at = excluded.completed_at`,
    ).run(sha, cues.length, now);
    imported = true;
  }

  return { hash: sha, imported };
});
