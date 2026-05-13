/* SPDX-License-Identifier: AGPL-3.0-or-later */

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
import { translateQueue } from '../utils/queue';

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

  // 00.queue.ts already kicked tryStartNext, but it ran before our
  // re-queue here in plugin-load order. Nudge again so the freshly
  // re-queued rows actually start.
  await translateQueue.tryStartNext();
});
