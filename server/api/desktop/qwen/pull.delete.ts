/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * DELETE /api/desktop/qwen/pull
 *
 * Abort an in-progress pull. Underlying fetch to Ollama's /api/pull is
 * cancelled; Ollama may keep the already-pulled layers around for the
 * next attempt.
 */

import { createError, defineEventHandler } from 'h3';
import { abortQwenPull } from '../../../utils/qwenPullTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return { aborted: abortQwenPull() };
});
