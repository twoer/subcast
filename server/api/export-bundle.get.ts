/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';

import { buildGenericArchiveBundleZip } from '../utils/subcastBundleExport';
import { HASH_RE } from '../utils/validate';

function toStatusCode(code: string): number {
  if (code === 'VIDEO_NOT_FOUND') return 404;
  if (code === 'NO_ORIGINAL_VTT' || code === 'NO_CUES') return 400;
  return 500;
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event);
  const hash = String(q.hash ?? '');
  if (!HASH_RE.test(hash)) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_HASH' });
  }

  const recipe = String(q.recipe ?? 'generic-archive-pack');
  if (recipe !== 'generic-archive-pack') {
    throw createError({ statusCode: 400, statusMessage: 'UNSUPPORTED_RECIPE' });
  }

  const lang = String(q.lang ?? 'zh-CN');
  if (lang !== 'zh-CN' && lang !== 'en') {
    throw createError({ statusCode: 400, statusMessage: 'BAD_LANG' });
  }

  try {
    const bundle = await buildGenericArchiveBundleZip(hash, lang);
    setResponseHeader(event, 'Content-Type', 'application/zip');
    setResponseHeader(
      event,
      'Content-Disposition',
      `attachment; filename="${bundle.filename}"`,
    );
    return bundle.buffer;
  } catch (err) {
    const code = err instanceof Error ? err.name : 'EXPORT_BUNDLE_FAILED';
    const message = err instanceof Error ? err.message : code;
    throw createError({
      statusCode: toStatusCode(code),
      statusMessage: code,
      message,
    });
  }
});
