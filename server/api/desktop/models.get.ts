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
import { existsSync } from 'node:fs';
import { loadSettings } from '../../utils/settings';
import { getDb } from '../../utils/db';
import { listInstalledWhisperModels } from '../../utils/whisperInstalled';
import { isSenseVoiceReady, senseVoiceModelDir } from '../../utils/sensevoice';
import { taskModelPolicyDecisions } from '../../utils/taskModelPolicy';
import { getLlmServer } from '../../utils/llmServer';
import { getWhisperServer } from '../../utils/whisperServer';
import { detectSubcastSidecars } from '../../utils/sidecarProcessStatus';
import { scanLlmModels, findLegacyQwen25Models } from '../../../desktop/modelManager/llmScan';
import { LLM_MODELS, type LlmModelId } from '#shared/llmModels';
import { llmModelPath, llmModelsDir } from '../../../desktop/modelManager/llmInstall';

interface InstalledLlmRow {
  name: LlmModelId;
  filename: string;
  sizeBytes: number;
}

interface RunningTranscribeTasks {
  count: number;
  engines: string[];
}

function runningLlmTaskCount(): number {
  try {
    const row = getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM translate_tasks WHERE status='running') +
           (SELECT COUNT(*) FROM polish_tasks WHERE status='running') +
           (SELECT COUNT(*) FROM insight_tasks WHERE status='running') AS n`,
      )
      .get() as { n?: number } | undefined;
    return Math.max(0, row?.n ?? 0);
  } catch {
    return 0;
  }
}

function runningTranscribeTasks(): RunningTranscribeTasks {
  try {
    const rows = getDb()
      .prepare(
        `SELECT COALESCE(model, 'auto') AS engine, COUNT(*) AS n
         FROM transcribe_tasks
         WHERE status='running'
         GROUP BY COALESCE(model, 'auto')
         ORDER BY n DESC`,
      )
      .all() as { engine?: string; n?: number }[];
    return {
      count: rows.reduce((sum, row) => sum + Math.max(0, row.n ?? 0), 0),
      engines: rows.flatMap((row) => (row.engine ? [row.engine] : [])),
    };
  } catch {
    return { count: 0, engines: [] };
  }
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

  // Post-Qwen3-upgrade guidance: an upgraded user's active tier points at
  // a Qwen3 file that isn't on disk yet (their old Qwen2.5 GGUF no longer
  // matches any catalog entry). Flag it so the settings page can offer a
  // one-click download instead of letting the first translate/insights
  // call die inside llama-server.
  const llmNeedsDownload =
    settings.llmModel !== undefined && !existsSync(llmModelPath(settings.llmModel));
  const legacyLlm =
    process.env.SUBCAST_DESKTOP === 'true'
      ? await findLegacyQwen25Models(llmModelsDir()).catch(() => [])
      : [];
  const runtime = getLlmServer().snapshot();
  const runningTasks = runningLlmTaskCount();
  const transcribeTasks = runningTranscribeTasks();
  const whisperRuntime = getWhisperServer().snapshot();
  const sidecars = await detectSubcastSidecars();
  const observedRuntime =
    runtime.state === 'idle' && sidecars.llamaServer
      ? {
          ...runtime,
          state: 'running' as const,
          modelId: runtime.modelId ?? settings.llmModel ?? null,
          idleDeadlineAt: null,
        }
      : runtime;
  const observedWhisperRuntime =
    whisperRuntime.state === 'idle' && sidecars.whisperServer
      ? {
          ...whisperRuntime,
          state: 'running' as const,
          idleDeadlineAt: null,
        }
      : whisperRuntime;
  const effectiveRuntime =
    runningTasks > 0 && observedRuntime.activeRequests === 0
      ? {
          ...observedRuntime,
          state: observedRuntime.state === 'idle' ? 'running' : observedRuntime.state,
          modelId: observedRuntime.modelId ?? settings.llmModel ?? null,
          idleDeadlineAt: null,
          activeRequests: runningTasks,
        }
      : observedRuntime;

  return {
    transcribeEngine: settings.transcribeEngine ?? 'auto',
    whisper: {
      active: settings.whisperModel,
      installed: whisperInstalled.map((m) => ({
        name: m.name,
        sizeBytes: m.sizeBytes,
      })),
    },
    sensevoice: {
      ready: isSenseVoiceReady(),
      dir: senseVoiceModelDir(),
    },
    transcribeRuntime: {
      state: transcribeTasks.count > 0 ? 'running' : observedWhisperRuntime.state,
      activeTasks: transcribeTasks.count,
      engines: transcribeTasks.engines,
      whisper: observedWhisperRuntime,
    },
    llm: {
      active: settings.llmModel,
      runtime: effectiveRuntime,
      installed: llmInstalled,
      needsDownload: llmNeedsDownload,
      taskPolicies: settings.llmModel
        ? taskModelPolicyDecisions({
            configuredModel: settings.llmModel,
            installedModels: llmInstalled.map((m) => m.name),
            dryRun: true,
          })
        : [],
      legacy: legacyLlm.map((f) => ({ filename: f.filename, sizeBytes: f.sizeBytes })),
    },
  };
});
