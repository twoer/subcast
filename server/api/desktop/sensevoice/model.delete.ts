/* SPDX-License-Identifier: Apache-2.0 */

/**
 * DELETE /api/desktop/sensevoice/model — remove the installed SenseVoice
 * model files. 409 when sensevoice is the active engine (deleting the
 * active engine's model would break the next transcription); 404 when
 * nothing is installed.
 */

import { createError, defineEventHandler } from 'h3';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings } from '../../../utils/settings';
import { removeSenseVoice, senseVoiceModelsDir } from '../../../../desktop/modelManager/senseVoiceInstall';

/**
 * Dismissed marker mirrors the old bundled-base pattern
 * (`.bundled-base-dismissed`): without it, desktop main re-seeds the
 * bundled SenseVoice symlink on the next launch and the user's delete
 * silently resurrects.
 */
const DISMISSED_MARKER = '.bundled-sensevoice-dismissed';

export default defineEventHandler(async () => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  const home = process.env.SUBCAST_HOME;
  if (!home) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  if (loadSettings().transcribeEngine === 'sensevoice') {
    throw createError({ statusCode: 409, statusMessage: 'IS_ACTIVE_ENGINE' });
  }

  if (!existsSync(senseVoiceModelsDir(home))) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_INSTALLED' });
  }

  await removeSenseVoice(home);
  try {
    const dir = join(home, 'models', 'sensevoice');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, DISMISSED_MARKER), '', 'utf8');
  } catch {
    // Marker is best-effort — without it the model may re-seed next
    // launch, which is preferable to failing the delete.
  }
  return { deleted: true };
});
