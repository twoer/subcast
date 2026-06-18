/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Translate + Insight recovery on Nitro boot (§ 6.10, decision 21).
 *
 *   - Web mode (`SUBCAST_DESKTOP !== 'true'`): demote any 'running' rows
 *     back to 'queued' so the queue picks them up. Web is short-lived;
 *     silent restart is the long-standing behavior and changing it
 *     would surprise existing users.
 *   - Desktop mode: mark them 'failed' / 'error' with an explanatory
 *     `error_msg`. The home page and queue surfaces show retry / ignore
 *     buttons so the user can decide. This prevents silently re-running
 *     a 60-minute translation that costs Ollama tokens, and matches the
 *     UX promise that closing-to-tray keeps work running and quitting
 *     deliberately stops it.
 */

import { getDb } from '../utils/db';
import { llmQueue } from '../utils/queue';

export default defineNitroPlugin(async () => {
  const db = getDb();
  const desktop = process.env.SUBCAST_DESKTOP === 'true';

  if (desktop) {
    db.prepare(
      `UPDATE translate_tasks
         SET status='failed',
             error_msg='Interrupted by app exit'
       WHERE status='running'`,
    ).run();
    db.prepare(
      `UPDATE insight_tasks
         SET status='error',
             error_msg='Interrupted by app exit'
       WHERE status='running'`,
    ).run();
    // diarize_tasks doesn't auto-restart (no llmQueue equivalent yet).
    // Mark zombies as failed so /run can re-INSERT instead of hitting
    // the ALREADY_RUNNING 409 guard. completed_at stamped for sort.
    db.prepare(
      `UPDATE diarize_tasks
         SET status='failed',
             error_code='INTERRUPTED',
             error_msg='Interrupted by app exit',
             completed_at=?
       WHERE status='running' OR status='pending'`,
    ).run(Date.now());
    return;
  }

  // Web mode: silent restart.
  db.prepare(
    `UPDATE translate_tasks
       SET status='queued',
           progress_pct=0
     WHERE status='running'`,
  ).run();
  db.prepare(
    `UPDATE insight_tasks
       SET status='queued'
     WHERE status='running'`,
  ).run();
  // Diarize has no queue worker yet; in web mode we also mark stale rows
  // failed so the user can retrigger via /run.
  db.prepare(
    `UPDATE diarize_tasks
       SET status='failed',
           error_code='INTERRUPTED',
           error_msg='Interrupted by server restart',
           completed_at=?
     WHERE status='running' OR status='pending'`,
  ).run(Date.now());

  // 00.queue.ts already kicked tryStartNext, but it ran before our
  // re-queue here in plugin-load order. Nudge again so the freshly
  // re-queued rows actually start.
  await llmQueue.tryStartNext();
});
