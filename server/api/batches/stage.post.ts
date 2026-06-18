/* SPDX-License-Identifier: Apache-2.0 */
import { createError, defineEventHandler, readFormData } from 'h3';
import { extname } from 'node:path';
import { MAX_VIDEO_BYTES, VIDEO_EXT, stageBatchVideo } from '../../utils/batchStage';

export default defineEventHandler(async (event) => {
  const formData = await readFormData(event);
  const file = formData.get('video');
  if (!(file instanceof File)) {
    throw createError({ statusCode: 400, statusMessage: 'video field missing' });
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw createError({ statusCode: 400, statusMessage: 'file > 2GB' });
  }
  const ext = extname(file.name).toLowerCase();
  if (!VIDEO_EXT.includes(ext as (typeof VIDEO_EXT)[number])) {
    throw createError({ statusCode: 400, statusMessage: `unsupported ext ${ext}` });
  }

  return stageBatchVideo(file);
});
