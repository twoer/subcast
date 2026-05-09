// Nitro auto-imports getDb / SUBCAST_PATHS from server/utils/db.ts.
import { createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const ALLOWED_EXT = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'];
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
  if (!ALLOWED_EXT.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: `unsupported ext ${ext}` });
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

  return { hash: sha };
});
