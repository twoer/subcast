/* SPDX-License-Identifier: Apache-2.0 */

/**
 * POST /api/desktop/upload-from-path   body: { path: string }
 *
 * Desktop-only sibling of `/api/upload`. The renderer can't construct a
 * `File` from an OS path (browser sandbox), so when the user double-
 * clicks a `.mp4` in Finder / Explorer or drops one onto the dock, the
 * file path reaches the renderer via the `subcast:open-file` IPC
 * channel — then the renderer calls this endpoint to hash and import
 * the file in place.
 *
 * No need to upload bytes over HTTP: the server already has direct
 * filesystem access. We stream-hash the source, copy into
 * `SUBCAST_PATHS.videos/<sha>.<ext>`, register the row, and return the
 * hash so the renderer can `navigateTo(/player/<hash>)`.
 *
 * 404 in web mode.
 */

import { createError, defineEventHandler, readBody } from 'h3';

import { importMediaFromPath, MediaImportError } from '../../utils/mediaImport';

interface UploadFromPathBody {
  path?: string;
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const body = await readBody<UploadFromPathBody>(event);
  const sourcePath = body?.path;
  if (!sourcePath) {
    throw createError({ statusCode: 400, statusMessage: 'path required' });
  }

  let imported;
  try {
    imported = await importMediaFromPath(sourcePath);
  } catch (err) {
    const code = err instanceof MediaImportError ? err.code : 'IMPORT_FAILED';
    throw createError({ statusCode: 400, statusMessage: code });
  }

  return { hash: imported.hash };
});
