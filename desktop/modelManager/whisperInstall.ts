/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Three install modes for a Whisper model (decision 34, § 5.7):
 *
 *   - `symlink` — `fs.symlink(srcPath, destPath)`. Zero extra disk; if the
 *     source is deleted, Subcast loses access. Recommended when source
 *     lives under another tool the user actively manages.
 *   - `copy`    — `fs.copyFile(srcPath, destPath)`. Costs ~150 MB-1.6 GB
 *     extra but keeps Subcast self-contained.
 *   - `download` — `downloadFile()` from HF or mirror.
 *
 * Each mode resolves the canonical install path via `whisperModelPath()`
 * so transcription handlers find the file at the expected location
 * (`<userData>/models/whisper/ggml-<model>.bin` in desktop mode).
 *
 * Module-level invariant: only one install runs at a time. The setup
 * wizard ensures this by disabling action buttons while a task is active.
 */

import { copyFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { whisperModelPath } from '../../server/utils/whisperPaths';
import type { DownloadOptions, DownloadProgress } from './downloader';
import { downloadFile } from './downloader';
import type { ProbeOptions } from './downloadRace';
import { pickFastestUrlWithDetail } from './downloadRace';
import { assertWhisperModelIntegrity } from './modelIntegrity';
import type { WhisperMirror } from './whisperConfig';
import { WHISPER_MODELS, whisperDownloadUrl, whisperDownloadUrls } from './whisperConfig';
import { MODEL_META } from './whisperScan';
import type { WhisperModelName } from './whisperScan';

async function ensureModelsDir(destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
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

function orderedAutoUrls(model: WhisperModelName, preferredUrl: string): string[] {
  return [
    preferredUrl,
    ...whisperDownloadUrls(model).filter((url) => url !== preferredUrl),
  ];
}

async function downloadFromCandidates(params: {
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
      console.warn(`[subcast] whisper download failed from ${url}: ${(err as Error).message}`);
    }
  }
  throw new MirrorDownloadError(errors);
}

/**
 * Symlink an existing on-disk Whisper model into the canonical location.
 * Removes any prior dest (file or symlink) so the operation is idempotent.
 */
export async function installBySymlink(
  srcPath: string,
  model: WhisperModelName,
): Promise<{ destPath: string }> {
  const destPath = whisperModelPath(model);
  await ensureModelsDir(destPath);
  if (await fileExists(destPath)) await rm(destPath, { force: true });
  await symlink(srcPath, destPath);
  return { destPath };
}

/**
 * Copy an existing on-disk Whisper model into the canonical location.
 * Replaces any prior content at the destination.
 */
export async function installByCopy(
  srcPath: string,
  model: WhisperModelName,
): Promise<{ destPath: string }> {
  const destPath = whisperModelPath(model);
  await ensureModelsDir(destPath);
  if (await fileExists(destPath)) await rm(destPath, { force: true });
  await copyFile(srcPath, destPath);
  return { destPath };
}

/**
 * Download a Whisper model from HF (or the configured mirror). The
 * downloader handles resume + verification; this wrapper just resolves
 * the URL and destination and pipes through progress + abort.
 */
export async function installByDownload(
  model: WhisperModelName,
  mirror: WhisperMirror,
  options: {
    onProgress?: (p: DownloadProgress) => void;
    signal?: AbortSignal;
    fetchImpl?: DownloadOptions['fetchImpl'];
    probe?: Pick<ProbeOptions, 'probeMs' | 'minBytes'>;
  } = {},
): Promise<{ destPath: string }> {
  const destPath = whisperModelPath(model);
  await ensureModelsDir(destPath);
  const meta = WHISPER_MODELS[model];
  // `mirror === 'auto'` → race huggingface.co vs hf-mirror.com,
  // download from whoever delivers faster. Falls through to the same
  // downloadFile() so resume / hash-verify / cancel are unchanged.
  //
  // If the race fails entirely (both sources timed out / under threshold —
  // e.g. CN users with HF blocked AND CDN cold-start eating probe budget)
  // we silently fall back to hf-mirror.com instead of bubbling the error
  // up. The user sees a download, not an opaque "no usable source" error.
  let urls: string[];
  if (mirror === 'auto') {
    try {
      const race = await pickFastestUrlWithDetail(whisperDownloadUrls(model), {
        signal: options.signal,
        probeMs: options.probe?.probeMs,
        minBytes: options.probe?.minBytes,
      });
      console.log(
        `[subcast] whisper auto-mirror picked ${race.winner} —`,
        race.measurements
          .map((m) => `${m.url}: ${(m.bytesPerSecond / 1024).toFixed(0)} KB/s${m.error ? ' (err)' : ''}`)
          .join(' / '),
      );
      urls = orderedAutoUrls(model, race.winner);
    } catch (err) {
      // User-cancellation must still propagate — only swallow the
      // "no usable source" race error.
      if (options.signal?.aborted) throw err;
      urls = orderedAutoUrls(model, whisperDownloadUrl(model, 'hf-mirror'));
      console.warn(
        `[subcast] whisper auto-mirror race failed (${(err as Error).message}); ` +
        `falling back to ${urls[0]}`,
      );
    }
  } else {
    urls = [whisperDownloadUrl(model, mirror)];
  }
  await downloadFromCandidates({
    urls,
    destPath,
    expectedSha256: meta.sha256,
    onProgress: options.onProgress,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    validate: () => assertWhisperModelIntegrity(destPath, {
      minBytes: MODEL_META[model].minBytes,
      maxBytes: MODEL_META[model].maxBytes,
      label: `Whisper ${model}`,
    }),
  });
  return { destPath };
}
