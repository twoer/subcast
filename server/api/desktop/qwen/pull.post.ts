/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * POST /api/desktop/qwen/pull   body: { variant: '3b' | '7b' | '14b' }
 *
 * Kicks off a Qwen pull via Ollama. Returns the running snapshot
 * immediately; subsequent polling against GET reflects NDJSON progress.
 * 409 if another pull is already running.
 */

import { createError, defineEventHandler, readBody } from 'h3';
import { QwenPullBusyError, startQwenPull } from '../../../utils/qwenPullTask';
import type { QwenVariant } from '../../../../desktop/modelManager/qwen';

const VALID_VARIANTS: ReadonlySet<QwenVariant> = new Set(['3b', '7b', '14b']);

interface PullBody { variant?: QwenVariant }

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  const body = await readBody<PullBody>(event);
  if (!body?.variant || !VALID_VARIANTS.has(body.variant)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_VARIANT' });
  }
  try {
    return startQwenPull(body.variant);
  } catch (err) {
    if (err instanceof QwenPullBusyError) {
      throw createError({ statusCode: 409, statusMessage: 'BUSY' });
    }
    throw err;
  }
});
