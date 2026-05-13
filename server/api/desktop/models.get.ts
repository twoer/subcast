/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * GET /api/desktop/models
 *
 * Aggregates everything the Settings → Models tab needs in one request:
 *   - whisper: currently-active model (from settings) + list installed
 *     at the canonical models dir (name + size).
 *   - ollama:  running flag + currently-active model (from settings) +
 *     full installed list from `/api/tags` (NOT filtered to qwen — the
 *     wizard's qwen-only view is a separate concern).
 *
 * 404 in web mode; auth via the desktop session token middleware.
 */

import { createError, defineEventHandler } from 'h3';
import { loadSettings } from '../../utils/settings';
import { listInstalledWhisperModels } from '../../utils/whisperInstalled';

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';

interface OllamaTagsResponse {
  models?: Array<{ name: string; size?: number; modified_at?: string }>;
}

async function probeOllama(): Promise<{
  running: boolean;
  models: Array<{ name: string; sizeBytes: number; modifiedAt: string | null }>;
}> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { running: false, models: [] };
    const body = (await res.json()) as OllamaTagsResponse;
    return {
      running: true,
      models: (body.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size ?? 0,
        modifiedAt: m.modified_at ?? null,
      })),
    };
  } catch {
    return { running: false, models: [] };
  }
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  void event;

  const settings = loadSettings();
  const [whisperInstalled, ollama] = await Promise.all([
    listInstalledWhisperModels(),
    probeOllama(),
  ]);

  return {
    whisper: {
      active: settings.whisperModel,
      installed: whisperInstalled.map((m) => ({
        name: m.name,
        sizeBytes: m.sizeBytes,
      })),
    },
    ollama: {
      running: ollama.running,
      active: settings.ollamaModel,
      installed: ollama.models,
    },
  };
});
