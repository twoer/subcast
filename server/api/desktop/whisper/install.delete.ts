/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * DELETE /api/desktop/whisper/install
 *
 * Abort an in-progress download. Symlink / copy run too fast to be
 * abortable — the call succeeds but is a no-op against them.
 */

import { createError, defineEventHandler } from 'h3';
import { abortInstall } from '../../../utils/whisperInstallTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return { aborted: abortInstall() };
});
