/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Desktop-side SenseVoice model install (download-only).
 *
 * Single fixed model — no catalog, no symlink/copy paths. Downloads
 * k2-fsa/sherpa-onnx's int8-only archive (~166 MB) and extracts
 * model.int8.onnx + tokens.txt into `$SUBCAST_HOME/models/sensevoice/`,
 * matching the layout `server/utils/sensevoice.ts` resolves at runtime.
 *
 * Mirrors the whisper/llm installers' shape (progress + abort via the
 * shared downloader) so the settings UI and install task tracker treat
 * all three identically.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile, type DownloadProgress } from './downloader';

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const ARCHIVE_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2';
// CN-friendly proxy (same convention as scripts/fetch-*.mjs).
const USE_PROXY = process.env.SUBCAST_GH_MIRROR !== 'direct';
const PROXY = USE_PROXY ? 'https://gh-proxy.com/' : '';
export const SENSE_VOICE_ARCHIVE_URL = `${PROXY}${GH}/asr-models/${ARCHIVE_NAME}`;

const MIN_MODEL_BYTES = 200_000_000;
const MIN_TOKENS_BYTES = 100_000;

export function senseVoiceModelsDir(home: string): string {
  return join(home, 'models', 'sensevoice');
}

function findIn(root: string, name: string): string | null {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      const hit = findIn(full, name);
      if (hit) return hit;
    } else if (e.name === name) return full;
  }
  return null;
}

export interface SenseVoiceInstallOptions {
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}

export async function installSenseVoiceByDownload(
  home: string,
  options: SenseVoiceInstallOptions = {},
): Promise<{ destDir: string }> {
  const destDir = senseVoiceModelsDir(home);
  const stage = await mkdtemp(join(tmpdir(), 'subcast-sensevoice-'));
  try {
    const archivePath = join(stage, 'sensevoice.tar.bz2');
    await downloadFile({
      url: SENSE_VOICE_ARCHIVE_URL,
      destPath: archivePath,
      onProgress: options.onProgress,
      signal: options.signal,
    });

    execFileSync('tar', ['-xjf', archivePath, '-C', stage], { stdio: 'ignore' });
    const model = findIn(stage, 'model.int8.onnx');
    const tokens = findIn(stage, 'tokens.txt');
    if (!model || !tokens) throw new Error('model.int8.onnx / tokens.txt missing inside archive');
    if (statSync(model).size < MIN_MODEL_BYTES) {
      throw new Error(`model.int8.onnx too small (${statSync(model).size}B) — likely truncated`);
    }

    await mkdir(destDir, { recursive: true });
    execFileSync('mv', [model, join(destDir, 'model.int8.onnx')]);
    execFileSync('mv', [tokens, join(destDir, 'tokens.txt')]);
    return { destDir };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** True when both files exist with plausible sizes (post-install check). */
export function isSenseVoiceInstalled(home: string): boolean {
  const dir = senseVoiceModelsDir(home);
  const model = join(dir, 'model.int8.onnx');
  const tokens = join(dir, 'tokens.txt');
  if (!existsSync(model) || !existsSync(tokens)) return false;
  return statSync(model).size >= MIN_MODEL_BYTES && statSync(tokens).size >= MIN_TOKENS_BYTES;
}

/** Delete the model files (and the dir when empty afterwards). */
export async function removeSenseVoice(home: string): Promise<void> {
  const dir = senseVoiceModelsDir(home);
  await rm(dir, { recursive: true, force: true });
}
