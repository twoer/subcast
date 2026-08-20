/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readBody } from 'h3';

import { getAgentMediaStatus, isAgentLanguage, isAgentRecipe } from '../../utils/agentMediaStatus';
import { importMediaFromPath, MediaImportError } from '../../utils/mediaImport';

interface AgentImportBody {
  path?: string;
  recipe?: string;
  language?: string;
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const body = await readBody<AgentImportBody>(event);
  if (!body?.path) {
    throw createError({ statusCode: 400, statusMessage: 'PATH_REQUIRED' });
  }
  const recipe = body.recipe;
  const language = body.language;
  if (recipe !== undefined && !isAgentRecipe(recipe)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_RECIPE' });
  }
  if (language !== undefined && !isAgentLanguage(language)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_LANG' });
  }

  let imported;
  try {
    imported = await importMediaFromPath(body.path);
  } catch (err) {
    const code = err instanceof MediaImportError ? err.code : 'IMPORT_FAILED';
    throw createError({ statusCode: 400, statusMessage: code });
  }

  return {
    ok: true,
    hash: imported.hash,
    hashPrefix: imported.hashPrefix,
    imported: true,
    media: getAgentMediaStatus({
      hash: imported.hash,
      recipe,
      language,
    }),
  };
});
