/* SPDX-License-Identifier: Apache-2.0 */
// Thin SSE shim over the polish task — same shape as translate.get.ts:
// ensure the task row, nudge the queue, then pipe worker frames to the
// player's manual "AI 润色" trigger.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getDb, SUBCAST_PATHS } from '../utils/db';
import { llmQueue } from '../utils/queue';
import { formatSse } from '../utils/sse';
import { setupSseStream } from '../utils/sseStream';
import { isValidHash } from '../utils/validate';
import type { VideoRow } from '../types/db';

export default defineEventHandler(async (event) => {
  const { hash } = getQuery(event);
  if (!isValidHash(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const db = getDb();
  const video = db
    .prepare('SELECT sha256 FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'sha256'> | undefined;
  if (!video) throw createError({ statusCode: 404, statusMessage: 'VIDEO_NOT_FOUND' });

  // Polish rewrites the original transcript — require it to exist first.
  const origPath = join(SUBCAST_PATHS.cache, hash, 'original.vtt');
  if (!existsSync(origPath)) {
    throw createError({ statusCode: 409, statusMessage: 'ORIGINAL_NOT_READY' });
  }

  const task = llmQueue.ensurePolishTask(hash);
  await llmQueue.tryStartNext();

  const sse = setupSseStream(event);
  let frameId = 0;
  try {
    for await (const frame of llmQueue.attach(task.id)) {
      if (sse.isClosed()) break;
      if (!sse.write(formatSse({ ...frame, id: frameId++ }))) break;
    }
  } finally {
    sse.close();
  }
});
