// Stream the cached video file with HTTP Range support so <video> can seek.
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

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

  const filePath = join(SUBCAST_PATHS.videos, `${row.sha256}${row.ext}`);
  const stat = statSync(filePath);
  const total = stat.size;
  const mime = MIME[row.ext.toLowerCase()] ?? 'application/octet-stream';
  const range = getRequestHeader(event, 'range');

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      throw createError({ statusCode: 416, statusMessage: 'BAD_RANGE' });
    }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (start >= total || end >= total || start > end) {
      setResponseHeader(event, 'Content-Range', `bytes */${total}`);
      throw createError({ statusCode: 416, statusMessage: 'RANGE_NOT_SATISFIABLE' });
    }
    setResponseStatus(event, 206);
    setResponseHeaders(event, {
      'Content-Type': mime,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    return sendStream(event, createReadStream(filePath, { start, end }));
  }

  setResponseHeaders(event, {
    'Content-Type': mime,
    'Content-Length': String(total),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  return sendStream(event, createReadStream(filePath));
});
