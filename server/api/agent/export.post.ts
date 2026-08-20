/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readBody, setResponseHeader } from 'h3';

import { getAgentMediaStatus, isAgentLanguage, isAgentRecipe } from '../../utils/agentMediaStatus';
import { buildMediaBundleZip } from '../../utils/subcastBundleExport';

interface AgentExportBody {
  hash?: string;
  recipe?: string;
  language?: string;
}

function statusCodeForExportError(code: string): number {
  if (code === 'BAD_HASH' || code === 'AMBIGUOUS_HASH' || code === 'BAD_RECIPE' || code === 'BAD_LANG') return 400;
  if (code === 'VIDEO_NOT_FOUND') return 404;
  if (code === 'MEDIA_NOT_READY' || code === 'INSIGHTS_REQUIRED' || code === 'NO_ORIGINAL_VTT' || code === 'NO_CUES') return 409;
  return 500;
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const body = await readBody<AgentExportBody>(event);
  const hash = body?.hash ?? '';
  const recipe = body?.recipe ?? 'generic-archive-pack';
  const language = body?.language ?? 'zh-CN';
  if (!isAgentRecipe(recipe)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_RECIPE' });
  }
  if (!isAgentLanguage(language)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_LANG' });
  }
  try {
    const status = getAgentMediaStatus({ hash, recipe, language });
    if (status.phase !== 'bundle_ready') {
      const err = new Error('MEDIA_NOT_READY');
      err.name = 'MEDIA_NOT_READY';
      throw err;
    }
    const bundle = await buildMediaBundleZip(status.hash, recipe, language);
    setResponseHeader(event, 'Content-Type', 'application/zip');
    setResponseHeader(event, 'Content-Disposition', `attachment; filename="${bundle.filename}"`);
    return bundle.buffer;
  } catch (err) {
    const code = err instanceof Error ? err.name : 'AGENT_EXPORT_FAILED';
    throw createError({
      statusCode: statusCodeForExportError(code),
      statusMessage: code,
    });
  }
});
