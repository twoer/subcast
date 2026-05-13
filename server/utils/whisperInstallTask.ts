/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Singleton tracker for the in-progress Whisper model install (symlink /
 * copy / download). The setup wizard polls `getInstallStatus()` from the
 * renderer while a task runs and gates the "Next →" button on its state.
 *
 * One task at a time — concurrent installs of the same model would race
 * the same destination file. Starting a second task while one is running
 * throws `BUSY`.
 *
 * Lifetimes: state persists for the lifetime of the Nitro process. Since
 * desktop-mode Nitro runs in the Electron main process, that means
 * "until the user quits the app." Closing the wizard mid-download keeps
 * the task running in the background — the user can come back to it.
 */

import type { DownloadProgress } from '../../desktop/modelManager/downloader';
import {
  installByCopy,
  installByDownload,
  installBySymlink,
} from '../../desktop/modelManager/whisperInstall';
import type { WhisperMirror } from '../../desktop/modelManager/whisperConfig';
import type { WhisperModelName } from '../../desktop/modelManager/whisperScan';

export type InstallKind = 'symlink' | 'copy' | 'download';
export type InstallState = 'running' | 'success' | 'error' | 'canceled';

export interface InstallTaskSnapshot {
  /** Generation id — increments on every `start`. Renderers compare this
   * across polls to detect when a new task replaces the old one. */
  id: number;
  kind: InstallKind;
  model: WhisperModelName;
  mirror?: WhisperMirror;
  state: InstallState;
  /** Live during 'running' for download; undefined for symlink/copy. */
  progress?: DownloadProgress;
  /** Set once state becomes 'success'. */
  destPath?: string;
  /** Set once state becomes 'error'. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

class InstallBusyError extends Error {
  constructor() {
    super('BUSY');
    this.name = 'InstallBusyError';
  }
}

let current: InstallTaskSnapshot | null = null;
let abortController: AbortController | null = null;
let nextId = 1;

export function getInstallStatus(): InstallTaskSnapshot | null {
  return current;
}

export interface StartInstallParams {
  kind: InstallKind;
  model: WhisperModelName;
  /** Source path for symlink / copy. */
  srcPath?: string;
  /** Mirror for download. */
  mirror?: WhisperMirror;
}

/**
 * Kick off a new install. Returns immediately with the task snapshot in
 * 'running' state; the actual work runs in the background. Throws
 * InstallBusyError if another install is already running.
 */
export function startInstall(params: StartInstallParams): InstallTaskSnapshot {
  if (current && current.state === 'running') {
    throw new InstallBusyError();
  }

  const snapshot: InstallTaskSnapshot = {
    id: nextId++,
    kind: params.kind,
    model: params.model,
    mirror: params.mirror,
    state: 'running',
    startedAt: Date.now(),
  };
  current = snapshot;

  const controller = new AbortController();
  abortController = controller;

  // Fire-and-forget the actual install; mutate the shared snapshot as it
  // progresses. Using a closure over `snapshot` keeps writes referencing
  // the same object the renderer reads through `getInstallStatus()`.
  void (async () => {
    try {
      if (params.kind === 'symlink') {
        if (!params.srcPath) throw new Error('srcPath required for symlink');
        const { destPath } = await installBySymlink(params.srcPath, params.model);
        snapshot.destPath = destPath;
      } else if (params.kind === 'copy') {
        if (!params.srcPath) throw new Error('srcPath required for copy');
        const { destPath } = await installByCopy(params.srcPath, params.model);
        snapshot.destPath = destPath;
      } else {
        const mirror: WhisperMirror = params.mirror ?? 'huggingface';
        const { destPath } = await installByDownload(params.model, mirror, {
          signal: controller.signal,
          onProgress: (p) => { snapshot.progress = p; },
        });
        snapshot.destPath = destPath;
      }
      snapshot.state = 'success';
    } catch (err) {
      // Distinguish user-initiated abort from real failures. AbortError
      // arrives with `name === 'AbortError'`; some fetch impls only
      // surface the message string ("The operation was aborted").
      const isAbort =
        controller.signal.aborted
        || (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message)));
      if (isAbort) {
        snapshot.state = 'canceled';
      } else {
        snapshot.state = 'error';
        snapshot.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      snapshot.finishedAt = Date.now();
      if (abortController === controller) abortController = null;
    }
  })();

  return snapshot;
}

/** Abort an in-progress download. Symlink / copy are too fast to abort. */
export function abortInstall(): boolean {
  if (!abortController) return false;
  abortController.abort();
  return true;
}

export { InstallBusyError };
