/* SPDX-License-Identifier: Apache-2.0 */

/** DELETE /api/desktop/sensevoice/install — abort an in-progress download. */

import { createError, defineEventHandler } from 'h3';
import { abortSenseVoiceInstall } from '../../../utils/sensevoiceInstallTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return { aborted: abortSenseVoiceInstall() };
});
