/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/desktop/sensevoice/install — start the SenseVoice model
 * download. Returns the running snapshot; poll GET for progress.
 * 409 if another install is already running.
 */

import { createError, defineEventHandler } from 'h3';
import {
  SenseVoiceInstallBusyError,
  startSenseVoiceInstall,
} from '../../../utils/sensevoiceInstallTask';

export default defineEventHandler(() => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  try {
    return startSenseVoiceInstall();
  } catch (err) {
    if (err instanceof SenseVoiceInstallBusyError) {
      throw createError({ statusCode: 409, statusMessage: 'BUSY' });
    }
    throw err;
  }
});
