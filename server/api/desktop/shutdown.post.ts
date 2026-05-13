/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * POST /api/desktop/shutdown
 *
 * Proactive cleanup right before the Electron main process exits. Called
 * once from `app.on('before-quit')` after `event.preventDefault()` so we
 * have a moment to flush in-flight work. The same shutdown that follows
 * (`app.exit(0)`) would otherwise leave `'running'` rows behind for
 * 02.recover-zombie-tasks to triage at the next launch.
 *
 * Idempotent: re-entrant calls do nothing extra. 404 in web mode.
 */

import { createError, defineEventHandler } from 'h3';
import { transcribeQueue, translateQueue } from '../../utils/queue';
import { abortAllInsightTasks } from '../../utils/insightTasks';
import { getLlmServer } from '../../utils/llmServer';

export default defineEventHandler(async () => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  const insightCount = abortAllInsightTasks();
  // Both await child-process reap (SIGTERM → SIGKILL grace, ~2s worst case).
  // The Electron caller's fetch timeout must be ≥ killGraceMs + slack.
  await Promise.all([transcribeQueue.cancelActive(), translateQueue.cancelActive()]);
  // Tear down the llama-server sidecar after queues drain — its singleton
  // owns a long-lived child process and a stale 51301 binding would block
  // the next launch from claiming the preferred port. Best-effort: any
  // failure here is logged but never blocks shutdown (the orphan-cleanup
  // pass at the next boot will mop up).
  try {
    await getLlmServer().stop();
  } catch (err) {
    console.warn('[shutdown] llm server stop failed:', err);
  }
  return { ok: true, abortedInsights: insightCount };
});
