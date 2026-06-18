/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/desktop/models
 *
 * Aggregates everything the Settings → Models tab needs in one request:
 *   - whisper: currently-active model (from settings) + list installed
 *     at the canonical models dir (name + size).
 *   - llm:     currently-active tier id (from settings) + list installed
 *     at the canonical LLM models dir. Backed by `scanLlmModels()` filtered
 *     to entries whose `path` matches the canonical `llmModelPath(id)` —
 *     i.e. GGUFs the user explicitly installed (symlink / copy / download)
 *     under Subcast's own dir, NOT every GGUF the scanner found on disk.
 *     No HTTP probe — llama-server is internal to Subcast.
 *
 * 404 in web mode; auth via the desktop session token middleware.
 */

import { createError, defineEventHandler } from 'h3';
import { loadSettings } from '../../utils/settings';
import { listInstalledWhisperModels } from '../../utils/whisperInstalled';
import { scanLlmModels } from '../../../desktop/modelManager/llmScan';
import { LLM_MODELS, type LlmModelId } from '#shared/llmModels';
import { llmModelPath } from '../../../desktop/modelManager/llmInstall';

interface InstalledLlmRow {
  name: LlmModelId;
  filename: string;
  sizeBytes: number;
}

async function listInstalledLlmModels(): Promise<InstalledLlmRow[]> {
  // Compare canonical install paths against scan results so a GGUF only
  // counts as "installed" when it sits inside Subcast's own models dir
  // (or is a symlink there pointing at the original LM Studio / Jan
  // copy). Same predicate `/api/desktop/llm/status` uses for the wizard.
  const scanned = await scanLlmModels();
  const canonical = new Map<string, LlmModelId>();
  for (const id of Object.keys(LLM_MODELS) as LlmModelId[]) {
    canonical.set(llmModelPath(id), id);
  }
  const seen = new Set<LlmModelId>();
  const rows: InstalledLlmRow[] = [];
  for (const m of scanned) {
    const id = canonical.get(m.path);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      name: id,
      filename: LLM_MODELS[id].filename,
      sizeBytes: m.sizeBytes,
    });
  }
  return rows;
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  void event;

  const settings = loadSettings();
  const [whisperInstalled, llmInstalled] = await Promise.all([
    listInstalledWhisperModels(),
    listInstalledLlmModels(),
  ]);

  return {
    whisper: {
      active: settings.whisperModel,
      installed: whisperInstalled.map((m) => ({
        name: m.name,
        sizeBytes: m.sizeBytes,
      })),
    },
    llm: {
      active: settings.llmModel,
      installed: llmInstalled,
    },
  };
});
