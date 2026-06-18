/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/desktop/setup-status
 *
 * Probes the Whisper side of the first-run state for the setup wizard.
 * The LLM side moved to a dedicated `/api/desktop/llm/status` endpoint
 * (richer per-tier data: installed / scanned / migration hint) — checking
 * it here too would duplicate the scan and force this endpoint to grow a
 * second mode. Callers that need LLM readiness now hit both endpoints.
 *
 * 404 in web mode — the endpoint only makes sense for the Electron shell.
 * Auth handled by `server/middleware/auth-desktop.ts` (every /api/ route
 * carries the session token in desktop mode).
 */

import { defineEventHandler, createError } from 'h3';
import { scanWhisperModels } from '../../../desktop/modelManager/whisperScan';
import { detectHardware } from '../../utils/hardware';
import { whisperModelPath } from '../../utils/whisperPaths';

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  // The unused param silences "event must be used" lint without hiding intent.
  void event;

  const whisperModels = await scanWhisperModels();

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
  };
});
