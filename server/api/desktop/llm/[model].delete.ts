/* SPDX-License-Identifier: Apache-2.0 */

/**
 * DELETE /api/desktop/llm/:model
 *
 * Removes the Qwen3-<size>-Q4_K_M.gguf file from the canonical
 * LLM models dir. Refuses with 409 if the requested model is currently set
 * as active in settings (deleting the active model would leave the next
 * insight generation with no usable file). 404 if the file isn't installed
 * in the first place.
 */

import { createError, defineEventHandler, getRouterParam } from 'h3';
import { unlink } from 'node:fs/promises';
import { loadSettings } from '../../../utils/settings';
import { llmModelPath } from '../../../../desktop/modelManager/llmInstall';
import { isLlmModelId, type LlmModelId } from '#shared/llmModels';

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const model = getRouterParam(event, 'model');
  if (typeof model !== 'string' || !isLlmModelId(model)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_MODEL' });
  }
  const id: LlmModelId = model;

  const settings = loadSettings();
  if (settings.llmModel === id) {
    throw createError({ statusCode: 409, statusMessage: 'IS_ACTIVE' });
  }

  const filePath = llmModelPath(id);
  try {
    await unlink(filePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw createError({ statusCode: 404, statusMessage: 'NOT_INSTALLED' });
    }
    throw e;
  }

  return { deleted: id };
});
