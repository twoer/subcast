import { createHash } from 'node:crypto';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Compute SHA-256 of a stream's content (read-only, no side effects).
 * Slice 1 does NOT call this in the upload path — `upload.post.ts` uses an
 * inline tee that hashes AND writes in one pass for performance. This util
 * is built early because spec §7 covers it; first real use is Slice 6
 * (companion subtitle integrity check) and Slice 9 (diagnostic bundle).
 */
export async function streamSha256(input: Readable): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    input,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest('hex');
}
