/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * GET /api/desktop/setup-status
 *
 * Probes the three first-run dependencies for the setup wizard:
 *   - hasWhisperModel: any plausible ggml-*.bin reachable from the scanner
 *   - ollamaRunning  : localhost:11434/api/tags responds
 *   - hasQwen        : Ollama lists any qwen* model
 *
 * 404 in web mode — the endpoint only makes sense for the Electron shell.
 * Auth handled by `server/middleware/auth-desktop.ts` (every /api/ route
 * carries the session token in desktop mode).
 */

import { defineEventHandler, createError } from 'h3';
import { scanWhisperModels } from '../../../desktop/modelManager/whisperScan';
import { detectHardware } from '../../utils/hardware';
import { whisperModelPath } from '../../utils/whisperPaths';

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

async function probeOllama(): Promise<{ running: boolean; models: string[] }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return { running: false, models: [] };
    const body = (await res.json()) as OllamaTagsResponse;
    return { running: true, models: (body.models ?? []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  // The unused param silences "event must be used" lint without hiding intent.
  void event;

  const [whisperModels, ollama] = await Promise.all([scanWhisperModels(), probeOllama()]);

  // Mark each scan hit as `installed` when its path matches the
  // canonical install location for that model. The wizard uses this
  // flag to: (a) display "✓ 已就绪" inline on the right card; (b)
  // default-select the largest installed model; (c) skip the
  // symlink/copy/ignore action UI for installed entries.
  const taggedModels = whisperModels.map((m) => ({
    name: m.name,
    path: m.path,
    source: m.source,
    installed: m.path === whisperModelPath(m.name),
  }));

  // Single source of truth for the "推荐" badge: hardware tier → model.
  // Settings → Overview already reads this via /api/settings; surfacing
  // it here lets the setup wizard's badge match instead of hard-coding
  // `base`. Cheap (just os.totalmem / cpus / platform).
  const hw = detectHardware();

  return {
    hasWhisperModel: taggedModels.some((m) => m.installed),
    whisperModels: taggedModels,
    recommendedWhisperModel: hw.recommended.whisperModel,
    recommendedOllamaModel: hw.recommended.ollamaModel,
    ollamaRunning: ollama.running,
    hasQwen: ollama.models.some((m) => m.toLowerCase().startsWith('qwen')),
    qwenModels: ollama.models.filter((m) => m.toLowerCase().startsWith('qwen')),
  };
});
