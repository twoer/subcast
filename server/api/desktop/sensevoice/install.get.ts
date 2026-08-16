/* SPDX-License-Identifier: Apache-2.0 */

/** GET /api/desktop/sensevoice/install — current install task snapshot. */

import { createError, defineEventHandler } from 'h3';
import { getSenseVoiceInstallStatus } from '../../../utils/sensevoiceInstallTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  return { install: getSenseVoiceInstallStatus() };
});
