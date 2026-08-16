/* SPDX-License-Identifier: Apache-2.0 */

/**
 * DELETE /api/desktop/llm/legacy — remove orphaned Qwen2.5 GGUFs left
 * in the canonical LLM models dir by the Qwen3 catalog switch. Only
 * ever touches files matching the legacy Qwen2.5-Instruct-Q4_K_M
 * pattern inside Subcast's own dir; current Qwen3 files and external
 * (LM Studio / Jan) copies are never touched.
 */

import { createError, defineEventHandler } from 'h3';
import { unlink } from 'node:fs/promises';
import { findLegacyQwen25Models } from '../../../../desktop/modelManager/llmScan';
import { llmModelsDir } from '../../../../desktop/modelManager/llmInstall';
import { logEvent } from '../../../utils/log';

export default defineEventHandler(async () => {
  if (process.env.SUBCAST_DESKTOP !== 'true' || !process.env.SUBCAST_HOME) {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const legacy = await findLegacyQwen25Models(llmModelsDir());
  const deleted: string[] = [];
  let freedBytes = 0;
  for (const file of legacy) {
    try {
      await unlink(file.path);
      deleted.push(file.filename);
      freedBytes += file.sizeBytes;
    } catch (err) {
      logEvent({
        level: 'warn',
        event: 'legacy_llm_delete_failed',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { deleted, freedBytes };
});
