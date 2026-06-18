/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/desktop/whisper/install
 *
 * Returns the current install task snapshot, or `null` if no install has
 * been kicked off this session. Renderer polls this every 500ms while a
 * task is running.
 */

import { createError, defineEventHandler } from 'h3';
import { getWhisperInstallStatus } from '../../../utils/whisperInstallTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return getWhisperInstallStatus();
});
