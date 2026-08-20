/* SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getDb, SUBCAST_PATHS } from './db';
import { backfillVideoDurationS } from './videoDuration';

const MEDIA_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'];
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

export class MediaImportError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = code;
  }
}

export interface ImportedMedia {
  hash: string;
  hashPrefix: string;
  ext: string;
  sizeBytes: number;
}

export async function importMediaFromPath(sourcePath: string): Promise<ImportedMedia> {
  let stats;
  try {
    stats = await stat(sourcePath);
  } catch {
    throw new MediaImportError('INPUT_NOT_READABLE');
  }
  if (!stats.isFile()) throw new MediaImportError('INPUT_NOT_FILE');
  if (stats.size > MAX_MEDIA_BYTES) throw new MediaImportError('INPUT_TOO_LARGE');

  const ext = extname(sourcePath).toLowerCase();
  if (!MEDIA_EXTENSIONS.includes(ext)) {
    throw new MediaImportError('INPUT_UNSUPPORTED_EXT');
  }

  await mkdir(SUBCAST_PATHS.tmp, { recursive: true });
  await mkdir(SUBCAST_PATHS.videos, { recursive: true });

  const originalName = basename(sourcePath);
  const tmpPath = join(SUBCAST_PATHS.tmp, `${Date.now()}-${originalName}`);
  const hash = createHash('sha256');
  const tap = new PassThrough();
  tap.on('data', (chunk: Buffer) => hash.update(chunk));

  await pipeline(createReadStream(sourcePath), tap, createWriteStream(tmpPath));
  const sha = hash.digest('hex');
  const finalPath = join(SUBCAST_PATHS.videos, `${sha}${ext}`);

  try {
    await rename(tmpPath, finalPath);
  } catch {
    await copyFile(tmpPath, finalPath);
    await unlink(tmpPath).catch(() => {});
  }

  const now = Date.now();
  getDb().prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET
       last_opened_at = excluded.last_opened_at,
       deleted_at = NULL`,
  ).run(sha, originalName, ext, stats.size, now, now);

  backfillVideoDurationS(sha, finalPath);
  return { hash: sha, hashPrefix: sha.slice(0, 12), ext, sizeBytes: stats.size };
}
