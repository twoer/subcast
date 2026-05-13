/* SPDX-License-Identifier: AGPL-3.0-or-later */

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
import type { DownloadProgress } from './downloader';
import { downloadFile } from './downloader';
import type { WhisperMirror } from './whisperConfig';
import { WHISPER_MODELS, whisperDownloadUrl } from './whisperConfig';
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
  } = {},
): Promise<{ destPath: string }> {
  const destPath = whisperModelPath(model);
  await ensureModelsDir(destPath);
  const meta = WHISPER_MODELS[model];
  await downloadFile({
    url: whisperDownloadUrl(model, mirror),
    destPath,
    expectedSha256: meta.sha256,
    onProgress: options.onProgress,
    signal: options.signal,
  });
  return { destPath };
}
