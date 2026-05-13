/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Three install modes for a llama.cpp GGUF model (mirrors whisperInstall.ts):
 *
 *   - `symlink` — `fs.symlink(srcPath, destPath)`. Zero extra disk; if the
 *     source is deleted, Subcast loses access. Recommended when source
 *     lives under another tool the user actively manages (e.g. LM Studio).
 *   - `copy`    — `fs.copyFile(srcPath, destPath)`. Costs ~2-9 GB extra but
 *     keeps Subcast self-contained.
 *   - `download` — `downloadFile()` from HF or mirror.
 *
 * Each mode resolves the canonical install path via `llmModelPath()` so
 * llama.cpp handlers find the file at the expected location
 * (`<SUBCAST_HOME>/models/llm/<filename>` in desktop mode).
 *
 * Module-level invariant: only one install runs at a time. The setup
 * wizard ensures this by disabling action buttons while a task is active.
 */

import { copyFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { downloadFile, type DownloadProgress } from './downloader';
import type { LlmMirror, LlmModelId } from './llmConfig';
import { LLM_MODELS, llmDownloadUrl } from './llmConfig';

function llmModelsDir(): string {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw new Error('llm install is desktop-only');
  }
  const home = process.env.SUBCAST_HOME;
  if (!home) throw new Error('SUBCAST_HOME not set');
  return join(home, 'models', 'llm');
}

export function llmModelPath(id: LlmModelId): string {
  return join(llmModelsDir(), LLM_MODELS[id].filename);
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Symlink an existing on-disk LLM GGUF into the canonical location.
 * Removes any prior dest (file or symlink) so the operation is idempotent.
 */
export async function installLlmBySymlink(
  srcPath: string,
  id: LlmModelId,
): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  if (await fileExists(destPath)) await rm(destPath, { force: true });
  await symlink(srcPath, destPath);
  return { destPath };
}

/**
 * Copy an existing on-disk LLM GGUF into the canonical location.
 * Replaces any prior content at the destination.
 */
export async function installLlmByCopy(
  srcPath: string,
  id: LlmModelId,
): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  if (await fileExists(destPath)) await rm(destPath, { force: true });
  await copyFile(srcPath, destPath);
  return { destPath };
}

/**
 * Download an LLM GGUF from HF (or the configured mirror). The downloader
 * handles resume + verification; this wrapper just resolves the URL and
 * destination and pipes through progress + abort.
 */
export async function installLlmByDownload(
  id: LlmModelId,
  mirror: LlmMirror,
  options: {
    onProgress?: (p: DownloadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  await downloadFile({
    url: llmDownloadUrl(id, mirror),
    destPath,
    expectedSha256: LLM_MODELS[id].sha256,
    onProgress: options.onProgress,
    signal: options.signal,
  });
  return { destPath };
}
