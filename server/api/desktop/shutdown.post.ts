/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/desktop/shutdown
 *
 * Proactive cleanup right before Electron exits. Called once from
 * `app.on('before-quit')` after `event.preventDefault()`. Cancels the
 * one in-flight transcribe + the one in-flight LLM task (translate or
 * insight), then tears down the resident LLM and Whisper servers.
 *
 * Idempotent. 404 in web mode.
 */

import { createError, defineEventHandler } from 'h3';
import { transcribeQueue, llmQueue } from '../../utils/queue';
import { getLlmServer } from '../../utils/llmServer';
import { getWhisperServer } from '../../utils/whisperServer';

export default defineEventHandler(async () => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  await Promise.all([transcribeQueue.cancelActive(), llmQueue.cancelActive()]);
  await Promise.all([
    getLlmServer().stop().catch((err) => {
      console.warn('[shutdown] llm server stop failed:', err);
    }),
    getWhisperServer().stop().catch((err) => {
      console.warn('[shutdown] whisper server stop failed:', err);
    }),
  ]);
  return { ok: true };
});
