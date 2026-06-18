/* SPDX-License-Identifier: Apache-2.0 */

/**
 * DELETE /api/desktop/whisper/:model
 *
 * Removes ggml-:model.bin from the canonical Whisper models dir. Refuses
 * with 409 if the requested model is currently set as active in settings
 * (deleting the active model would leave the next transcribe run with no
 * usable file). 404 if the file isn't installed in the first place.
 */

import { createError, defineEventHandler, getRouterParam } from 'h3';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadSettings } from '../../../utils/settings';
import { whisperModelPath } from '../../../utils/whisperPaths';

const VALID_MODELS: ReadonlySet<string> = new Set([
  'tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo',
]);

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const model = getRouterParam(event, 'model');
  if (!model || !VALID_MODELS.has(model)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_MODEL' });
  }

  const settings = loadSettings();
  if (settings.whisperModel === model) {
    throw createError({ statusCode: 409, statusMessage: 'IS_ACTIVE' });
  }

  const filePath = whisperModelPath(model);
  try {
    await unlink(filePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw createError({ statusCode: 404, statusMessage: 'NOT_INSTALLED' });
    }
    throw e;
  }

  // 'base' is shipped pre-seeded as a symlink into the .app bundle (see
  // desktop/modelManager/seedBundledModel.ts). Without a marker the next
  // app launch would silently re-create it — which would make this
  // delete look like it didn't take. Drop a sentinel so the seed step
  // skips on subsequent boots.
  if (model === 'base') {
    try {
      await writeFile(join(dirname(filePath), '.bundled-base-dismissed'), '');
    } catch {
      // best-effort: if the marker can't be written the user can still
      // re-delete next launch.
    }
  }

  return { deleted: model };
});
