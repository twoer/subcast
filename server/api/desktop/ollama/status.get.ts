/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * GET /api/desktop/ollama/status
 *
 * Returns the tristate Ollama detection (running / installed-not-running /
 * needs-install) plus the API version when reachable. Setup wizard Step 2
 * polls this every 5s while the user is in the "I've installed it"
 * waiting state.
 */

import { createError, defineEventHandler } from 'h3';
import { detectOllamaState } from '../../../../desktop/ollamaDetector';

export default defineEventHandler(async () => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return await detectOllamaState();
});
