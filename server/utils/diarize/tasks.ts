/* SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';

import { CONSOLIDATE_DEFAULTS } from '#shared/diarization';
import { getDb } from '../db';
import { hasCompletedTranscribeChunks } from './readiness';

export class TranscribeNotDoneError extends Error {
  constructor() {
    super('TRANSCRIBE_NOT_DONE');
    this.name = 'TranscribeNotDoneError';
  }
}

export interface EnsureDiarizeTaskResult {
  taskId: string;
  status: 'running';
  alreadyRunning: boolean;
}

export function ensureDiarizeTask(
  videoSha: string,
  opts: { topK?: number } = {},
): EnsureDiarizeTaskResult {
  const db = getDb();
  if (!hasCompletedTranscribeChunks(db, videoSha)) {
    throw new TranscribeNotDoneError();
  }

  const existing = db
    .prepare('SELECT id, status FROM diarize_tasks WHERE video_sha = ?')
    .get(videoSha) as { id: string; status: string } | undefined;
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    return { taskId: existing.id, status: 'running', alreadyRunning: true };
  }

  const topK = opts.topK ?? CONSOLIDATE_DEFAULTS.topK;
  if (existing) {
    db.prepare(
      `UPDATE diarize_tasks
       SET status='running',
           error_code=NULL,
           error_msg=NULL,
           completed_at=NULL,
           top_k=?,
           mode='top_k'
       WHERE id=?`,
    ).run(topK, existing.id);
    return { taskId: existing.id, status: 'running', alreadyRunning: false };
  }

  const taskId = randomUUID();
  db.prepare(
    `INSERT INTO diarize_tasks (id, video_sha, status, top_k, mode, created_at)
     VALUES (?, ?, 'running', ?, 'top_k', ?)`,
  ).run(taskId, videoSha, topK, Date.now());
  return { taskId, status: 'running', alreadyRunning: false };
}
