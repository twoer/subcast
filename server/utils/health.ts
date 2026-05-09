import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
const NW_ROOT = join(
  process.cwd(),
  'node_modules',
  'nodejs-whisper',
  'cpp',
  'whisper.cpp',
);
const CLI_PATH = join(NW_ROOT, 'build', 'bin', 'whisper-cli');
const MODELS_DIR = join(NW_ROOT, 'models');

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
  const binaryPresent = existsSync(CLI_PATH);
  let models: string[] = [];
  if (existsSync(MODELS_DIR)) {
    try {
      models = readdirSync(MODELS_DIR)
        .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
        .map((f) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''));
    } catch {
      /* ignore */
    }
  }
  return { binaryPresent, binaryPath: CLI_PATH, models };
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
