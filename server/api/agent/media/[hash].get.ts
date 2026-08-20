/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3';

import {
  AgentMediaStatusError,
  getAgentMediaStatus,
  isAgentLanguage,
  isAgentRecipe,
} from '../../../utils/agentMediaStatus';

function statusCodeForAgentMediaError(code: string): number {
  if (code === 'BAD_HASH' || code === 'AMBIGUOUS_HASH') return 400;
  if (code === 'VIDEO_NOT_FOUND') return 404;
  return 500;
}

export default defineEventHandler((event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const hash = getRouterParam(event, 'hash') ?? '';
  const query = getQuery(event);
  const recipe = query.recipe === undefined ? undefined : String(query.recipe);
  const language = query.language === undefined ? undefined : String(query.language);
  if (recipe !== undefined && !isAgentRecipe(recipe)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_RECIPE' });
  }
  if (language !== undefined && !isAgentLanguage(language)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_LANG' });
  }

  try {
    return getAgentMediaStatus({ hash, recipe, language });
  } catch (err) {
    const code = err instanceof AgentMediaStatusError ? err.code : 'AGENT_MEDIA_STATUS_FAILED';
    throw createError({
      statusCode: statusCodeForAgentMediaError(code),
      statusMessage: code,
    });
  }
});
