/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * GET /api/desktop/qwen/pull
 *
 * Current pull snapshot, or null if no pull has been kicked off this
 * session. Wizard polls this every 500ms while running.
 */

import { createError, defineEventHandler } from 'h3';
import { getQwenPullStatus } from '../../../utils/qwenPullTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return getQwenPullStatus();
});
