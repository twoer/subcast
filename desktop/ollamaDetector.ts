/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Ollama detection — probe the local HTTP API and, when offline, sniff
 * well-known install locations to distinguish "not installed" from
 * "installed but not running" (§ 5.3).
 *
 * Critically: this module never `spawn`s the user's Ollama. Ollama has
 * its own launchd / service manager — taking over its lifecycle is a
 * support nightmare. We detect, point users at install, and re-check.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';

export type OllamaState = 'running' | 'installed-not-running' | 'needs-install';

export interface OllamaSnapshot {
  state: OllamaState;
  /** Ollama API version string, when running. */
  version?: string;
  /** Detected binary path when offline-but-installed. Useful for diagnostics. */
  binaryPath?: string;
}

interface VersionResponse {
  version?: string;
}

/** Two-second probe; treats any non-2xx or network error as "not running". */
export async function probeOllama(): Promise<{ running: boolean; version?: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return { running: false };
    const body = (await res.json()) as VersionResponse;
    return { running: true, version: body.version };
  } catch {
    return { running: false };
  }
}

function platformBinaryCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/Applications/Ollama.app/Contents/MacOS/ollama',
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
    ];
  }
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return [
      join(localApp, 'Programs', 'Ollama', 'ollama.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe',
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
}

export async function detectOllamaState(): Promise<OllamaSnapshot> {
  const probe = await probeOllama();
  if (probe.running) return { state: 'running', version: probe.version };

  for (const candidate of platformBinaryCandidates()) {
    if (existsSync(candidate)) {
      return { state: 'installed-not-running', binaryPath: candidate };
    }
  }
  return { state: 'needs-install' };
}
