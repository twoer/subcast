/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/desktop/whisper/install
 *
 * Body:
 *   { kind: 'symlink' | 'copy', model, srcPath }
 *   { kind: 'download', model, mirror? }
 *
 * Returns the snapshot of the just-started task (state = 'running').
 * Subsequent polling at GET /api/desktop/whisper/install reflects progress.
 *
 * 409 if another install is already running.
 */

import { createError, defineEventHandler, readBody } from 'h3';
import {
  WhisperInstallBusyError,
  startWhisperInstall,
} from '../../../utils/whisperInstallTask';
import type { WhisperModelName } from '../../../../desktop/modelManager/whisperScan';
import type { WhisperMirror } from '../../../../desktop/modelManager/whisperConfig';
import {
  INSTALL_KINDS,
  isInstallKind,
  isInstallMirror,
  type InstallKind,
} from '../../../../shared/installContracts';

interface InstallBody {
  kind?: unknown;
  model?: WhisperModelName;
  srcPath?: string;
  mirror?: unknown;
}

const VALID_KINDS: ReadonlySet<InstallKind> = new Set(INSTALL_KINDS);
const VALID_MODELS: ReadonlySet<WhisperModelName> = new Set([
  'tiny',
  'base',
  'small',
  'medium',
  'large-v3-turbo',
]);

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const body = await readBody<InstallBody>(event);
  if (!body || !isInstallKind(body.kind) || !VALID_KINDS.has(body.kind)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_KIND' });
  }
  if (!body.model || !VALID_MODELS.has(body.model)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_MODEL' });
  }
  if ((body.kind === 'symlink' || body.kind === 'copy') && !body.srcPath) {
    throw createError({ statusCode: 400, statusMessage: 'SRC_PATH_REQUIRED' });
  }
  if (body.kind === 'download' && body.mirror !== undefined && !isInstallMirror(body.mirror)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_MIRROR' });
  }
  const mirror = body.kind === 'download' ? body.mirror as WhisperMirror | undefined : undefined;

  try {
    return startWhisperInstall({
      kind: body.kind,
      model: body.model,
      srcPath: body.srcPath,
      mirror,
    });
  } catch (err) {
    if (err instanceof WhisperInstallBusyError) {
      throw createError({ statusCode: 409, statusMessage: 'BUSY' });
    }
    throw err;
  }
});
