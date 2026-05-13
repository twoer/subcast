/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { existsSync, readdirSync } from 'node:fs';
import { WHISPER_CLI_PATH, WHISPER_MODELS_DIR } from './whisperPaths';
import { logEvent } from './log';

export interface HealthSnapshot {
  ollama: {
    running: boolean;
    models: string[];
    error?: string;
  };
  whisper: {
    binaryPresent: boolean;
    binaryPath: string;
    models: string[];
  };
  ready: boolean;
  missing: string[]; // e.g., ['ollama', 'qwen2.5:7b', 'whisper-cli']
}

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';

async function probeOllama(): Promise<HealthSnapshot['ollama']> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return { running: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return {
      running: true,
      models: (data.models ?? []).map((m) => m.name),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { running: false, models: [], error: msg };
  }
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

export async function detectHealth(
  required: { whisperModel: string; ollamaModel: string },
): Promise<HealthSnapshot> {
  const [ollama, whisper] = await Promise.all([probeOllama(), Promise.resolve(probeWhisper())]);
  const missing: string[] = [];
  if (!ollama.running) missing.push('ollama');
  if (ollama.running) {
    const family = required.ollamaModel.split(':')[0];
    const has = ollama.models.some(
      (m) => m === required.ollamaModel || (family && m.startsWith(`${family}:`)),
    );
    if (!has) missing.push(`ollama-model:${required.ollamaModel}`);
  }
  if (!whisper.binaryPresent) missing.push('whisper-cli');
  if (whisper.binaryPresent && !whisper.models.includes(required.whisperModel)) {
    missing.push(`whisper-model:${required.whisperModel}`);
  }
  return {
    ollama,
    whisper,
    ready: missing.length === 0,
    missing,
  };
}
