/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * POST /api/desktop/llm/install
 *
 * Body:
 *   { kind: 'symlink' | 'copy', model, srcPath }
 *   { kind: 'download', model, mirror? }
 *
 * Returns the snapshot of the just-started task (state = 'running').
 * Subsequent polling at GET /api/desktop/llm/install reflects progress.
 *
 * 409 if another install is already running.
 */

import { createError, defineEventHandler, readBody } from 'h3';
import {
  InstallBusyError,
  startInstall,
  type InstallKind,
} from '../../../utils/llmInstallTask';
import type { LlmMirror, LlmModelId } from '../../../../desktop/modelManager/llmConfig';

interface InstallBody {
  kind?: InstallKind;
  model?: LlmModelId;
  srcPath?: string;
  mirror?: LlmMirror;
}

const VALID_KINDS: ReadonlySet<InstallKind> = new Set(['symlink', 'copy', 'download']);
const VALID_MODELS: ReadonlySet<LlmModelId> = new Set(['3b', '7b', '14b']);

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const body = await readBody<InstallBody>(event);
  if (!body || !body.kind || !VALID_KINDS.has(body.kind)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_KIND' });
  }
  if (!body.model || !VALID_MODELS.has(body.model)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_MODEL' });
  }
  if ((body.kind === 'symlink' || body.kind === 'copy') && !body.srcPath) {
    throw createError({ statusCode: 400, statusMessage: 'SRC_PATH_REQUIRED' });
  }

  try {
    return startInstall({
      kind: body.kind,
      model: body.model,
      srcPath: body.srcPath,
      mirror: body.mirror,
    });
  } catch (err) {
    if (err instanceof InstallBusyError) {
      throw createError({ statusCode: 409, statusMessage: 'BUSY' });
    }
    throw err;
  }
});
