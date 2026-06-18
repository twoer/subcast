/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/desktop/llm/install
 *
 * Returns the current install task snapshot, or `null` if no install has
 * been kicked off this session. Renderer polls this every 500ms while a
 * task is running.
 */

import { createError, defineEventHandler } from 'h3';
import { getLlmInstallStatus } from '../../../utils/llmInstallTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return getLlmInstallStatus();
});
