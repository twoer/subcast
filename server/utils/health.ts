/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readdirSync } from 'node:fs';
import { WHISPER_CLI_PATH, WHISPER_MODELS_DIR } from './whisperPaths';
import { logEvent } from './log';

export interface HealthSnapshot {
  whisper: {
    binaryPresent: boolean;
    binaryPath: string;
    models: string[];
  };
  ready: boolean;
  missing: string[]; // e.g., ['whisper-cli', 'whisper-model:small']
}

function probeWhisper(): HealthSnapshot['whisper'] {
  const binaryPresent = existsSync(WHISPER_CLI_PATH);
  let models: string[] = [];
  if (existsSync(WHISPER_MODELS_DIR)) {
    try {
      models = readdirSync(WHISPER_MODELS_DIR)
        .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
        .map((f) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''));
    } catch (err) {
      logEvent({
        level: 'debug',
        event: 'whisper_models_list_failed',
        path: WHISPER_MODELS_DIR,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { binaryPresent, binaryPath: WHISPER_CLI_PATH, models };
}

/**
 * Build a lightweight readiness snapshot for the homepage banner.
 *
 * The 0.1 build also probed Ollama (HTTP GET /api/tags + a tag-match
 * against the configured model). Subcast 0.2 swapped Ollama for an
 * in-process llama-server spawned on demand from Subcast's own bundled
 * binary, so the only remaining external dependency the banner cares
 * about is whisper-cli + the whisper model file. LLM readiness is
 * surfaced separately by `/api/desktop/llm/status` (desktop only),
 * and by the AppHeader chip via `useActiveModels`.
 */
export async function detectHealth(
  required: { whisperModel: string },
): Promise<HealthSnapshot> {
  const whisper = probeWhisper();
  const missing: string[] = [];
  if (!whisper.binaryPresent) missing.push('whisper-cli');
  if (whisper.binaryPresent && !whisper.models.includes(required.whisperModel)) {
    missing.push(`whisper-model:${required.whisperModel}`);
  }
  return {
    whisper,
    ready: missing.length === 0,
    missing,
  };
}
