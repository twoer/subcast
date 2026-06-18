/* SPDX-License-Identifier: Apache-2.0 */
// Restart recovery for transcribe + LLM queues. Transcription has chunk-level
// resume — interrupted runs continue from the last completed chunk, so
// demoting 'running' back to 'queued' is safe and the desired UX.
//
// Translate + Insight recovery lives in 02.recover-zombie-tasks.ts: in
// desktop mode we mark them 'failed'/'error' so the user can decide to
// retry rather than silently re-spending tokens (§6.10, decision 21).
// Web mode keeps the silent-restart behavior there.
import { getDb } from '../utils/db';
import { transcribeQueue, llmQueue } from '../utils/queue';

export default defineNitroPlugin(async () => {
  const db = getDb();
  db.prepare(`UPDATE transcribe_tasks SET status='queued' WHERE status='running'`).run();
  await transcribeQueue.tryStartNext();
  // llmQueue is started after 02.recover-zombie-tasks has had a chance to
  // (web) re-queue or (desktop) fail-mark surviving translate + insight rows.
  await llmQueue.tryStartNext();
});
