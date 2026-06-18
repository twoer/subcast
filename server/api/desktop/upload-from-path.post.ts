/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/desktop/upload-from-path   body: { path: string }
 *
 * Desktop-only sibling of `/api/upload`. The renderer can't construct a
 * `File` from an OS path (browser sandbox), so when the user double-
 * clicks a `.mp4` in Finder / Explorer or drops one onto the dock, the
 * file path reaches the renderer via the `subcast:open-file` IPC
 * channel — then the renderer calls this endpoint to hash and import
 * the file in place.
 *
 * No need to upload bytes over HTTP: the server already has direct
 * filesystem access. We stream-hash the source, copy into
 * `SUBCAST_PATHS.videos/<sha>.<ext>`, register the row, and return the
 * hash so the renderer can `navigateTo(/player/<hash>)`.
 *
 * 404 in web mode.
 */

import { createError, defineEventHandler, readBody } from 'h3';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'];
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

interface UploadFromPathBody {
  path?: string;
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const body = await readBody<UploadFromPathBody>(event);
  const sourcePath = body?.path;
  if (!sourcePath) {
    throw createError({ statusCode: 400, statusMessage: 'path required' });
  }

  // Statting up-front gates the import on existence + size before we
  // commit to hashing a multi-GB file.
  let stats;
  try {
    stats = await stat(sourcePath);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'path not readable' });
  }
  if (!stats.isFile()) {
    throw createError({ statusCode: 400, statusMessage: 'path is not a file' });
  }
  if (stats.size > MAX_BYTES) {
    throw createError({ statusCode: 400, statusMessage: 'file > 2GB' });
  }
  const ext = extname(sourcePath).toLowerCase();
  if (!VIDEO_EXT.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: `unsupported ext ${ext}` });
  }

  await mkdir(SUBCAST_PATHS.tmp, { recursive: true });
  await mkdir(SUBCAST_PATHS.videos, { recursive: true });

  const originalName = basename(sourcePath);
  const tmpPath = join(SUBCAST_PATHS.tmp, `${Date.now()}-${originalName}`);

  const hash = createHash('sha256');
  const tap = new (await import('node:stream')).PassThrough();
  tap.on('data', (chunk: Buffer) => hash.update(chunk));

  await pipeline(createReadStream(sourcePath), tap, createWriteStream(tmpPath));
  const sha = hash.digest('hex');
  const finalPath = join(SUBCAST_PATHS.videos, `${sha}${ext}`);

  // rename across filesystems may fail on some setups (tmp on a different
  // mount). Falling back to a copy + unlink keeps imports resilient.
  const { rename, copyFile, unlink } = await import('node:fs/promises');
  try {
    await rename(tmpPath, finalPath);
  } catch {
    await copyFile(tmpPath, finalPath);
    await unlink(tmpPath).catch(() => { /* swallow */ });
  }

  const now = Date.now();
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET last_opened_at = excluded.last_opened_at, deleted_at = NULL`,
  ).run(sha, originalName, ext, stats.size, now, now);

  return { hash: sha };
});
