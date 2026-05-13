/* SPDX-License-Identifier: AGPL-3.0-or-later */
// Restart recovery for the transcribe queue. Transcription has chunk-level
// resume — interrupted runs continue from the last completed chunk, so
// demoting 'running' back to 'queued' is safe and the desired UX.
//
// Translation and Insight recovery lives in 02.recover-zombie-tasks.ts:
// in desktop mode we mark them 'failed'/'error' so the user can decide
// to retry rather than silently re-spending Ollama tokens (§6.10,
// decision 21). Web mode keeps the old silent-restart behavior there.
import { getDb } from '../utils/db';
import { transcribeQueue, translateQueue } from '../utils/queue';

export default defineNitroPlugin(async () => {
  const db = getDb();
  db.prepare(`UPDATE transcribe_tasks SET status='queued' WHERE status='running'`).run();
  await transcribeQueue.tryStartNext();
  // translateQueue is started after 02.recover-zombie-tasks has had a
  // chance to (web) re-queue or (desktop) fail-mark surviving rows.
  await translateQueue.tryStartNext();
});
