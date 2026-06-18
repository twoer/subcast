/* SPDX-License-Identifier: Apache-2.0 */

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
import { downloadFile, type DownloadOptions, type DownloadProgress } from './downloader';
import type { ProbeOptions } from './downloadRace';
import { pickFastestUrlWithDetail } from './downloadRace';
import type { LlmMirror, LlmModelId } from './llmConfig';
import { LLM_MODELS, llmDownloadUrl, llmDownloadUrls } from './llmConfig';
import { assertGgufModelIntegrity } from './modelIntegrity';

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

class MirrorDownloadError extends Error {
  constructor(
    public readonly errors: Array<{ url: string; error: unknown }>,
  ) {
    super(`all model download sources failed: ${errors.map((e) => `${e.url}: ${(e.error as Error).message}`).join(' / ')}`);
    this.name = 'MirrorDownloadError';
  }
}

function orderedAutoUrls(id: LlmModelId, preferredUrl: string): string[] {
  return [
    preferredUrl,
    ...llmDownloadUrls(id).filter((url) => url !== preferredUrl),
  ];
}

export async function downloadLlmFromCandidates(params: {
  urls: string[];
  destPath: string;
  expectedSha256?: string;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: DownloadOptions['fetchImpl'];
  validate?: () => Promise<void>;
}): Promise<void> {
  const errors: Array<{ url: string; error: unknown }> = [];
  for (const url of params.urls) {
    try {
      await downloadFile({
        url,
        destPath: params.destPath,
        expectedSha256: params.expectedSha256,
        onProgress: params.onProgress,
        signal: params.signal,
        fetchImpl: params.fetchImpl,
      });
      await params.validate?.();
      return;
    } catch (err) {
      if (params.signal?.aborted) throw err;
      errors.push({ url, error: err });
      console.warn(`[subcast] llm download failed from ${url}: ${(err as Error).message}`);
    }
  }
  throw new MirrorDownloadError(errors);
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
    fetchImpl?: DownloadOptions['fetchImpl'];
    probe?: Pick<ProbeOptions, 'probeMs' | 'minBytes'>;
  } = {},
): Promise<{ destPath: string }> {
  const destPath = llmModelPath(id);
  await ensureDir(destPath);
  // `mirror === 'auto'` → race huggingface.co vs hf-mirror.com,
  // download from whoever delivers faster. Falls through to the same
  // downloadFile() so resume / hash-verify / cancel are unchanged.
  //
  // If the race fails entirely (both sources timed out / under threshold)
  // we silently fall back to hf-mirror.com — mirror whisperInstall.ts'
  // graceful degradation so users don't see opaque "no usable source".
  let urls: string[];
  if (mirror === 'auto') {
    try {
      const race = await pickFastestUrlWithDetail(llmDownloadUrls(id), {
        signal: options.signal,
        probeMs: options.probe?.probeMs,
        minBytes: options.probe?.minBytes,
      });
      console.log(
        `[subcast] llm auto-mirror picked ${race.winner} —`,
        race.measurements
          .map((m) => `${m.url}: ${(m.bytesPerSecond / 1024).toFixed(0)} KB/s${m.error ? ' (err)' : ''}`)
          .join(' / '),
      );
      urls = orderedAutoUrls(id, race.winner);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      urls = orderedAutoUrls(id, llmDownloadUrl(id, 'hf-mirror'));
      console.warn(
        `[subcast] llm auto-mirror race failed (${(err as Error).message}); ` +
        `falling back to ${urls[0]}`,
      );
    }
  } else {
    urls = [llmDownloadUrl(id, mirror)];
  }
  await downloadLlmFromCandidates({
    urls,
    destPath,
    expectedSha256: LLM_MODELS[id].sha256,
    onProgress: options.onProgress,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    validate: () => assertGgufModelIntegrity(destPath, {
      sizeBytes: LLM_MODELS[id].sizeBytes,
      label: `Qwen2.5 ${id}`,
    }),
  });
  return { destPath };
}
