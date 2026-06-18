/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Singleton tracker for the in-progress LLM (Qwen 2.5 GGUF) install
 * (symlink / copy / download). The setup wizard polls `getLlmInstallStatus()`
 * from the renderer while a task runs and gates the "Next →" button on
 * its state.
 *
 * One task at a time — concurrent installs of the same model would race
 * the same destination file. Starting a second task while one is running
 * throws `BUSY`.
 *
 * Lifetimes: state persists for the lifetime of the Nitro process. Since
 * desktop-mode Nitro runs in the Electron main process, that means
 * "until the user quits the app." Closing the wizard mid-download keeps
 * the task running in the background — the user can come back to it.
 *
 * Mirrors `server/utils/whisperInstallTask.ts` — same state machine, same
 * snapshot shape, different model id type + install primitives.
 */

import {
  installLlmByCopy,
  installLlmByDownload,
  installLlmBySymlink,
} from '../../desktop/modelManager/llmInstall';
import type { LlmMirror, LlmModelId } from '#shared/llmModels';
import type { InstallKind, LlmInstallSnapshot } from '../../shared/installContracts';

export type LlmInstallTaskSnapshot = LlmInstallSnapshot;

class LlmInstallBusyError extends Error {
  constructor() {
    super('BUSY');
    this.name = 'LlmInstallBusyError';
  }
}

let current: LlmInstallTaskSnapshot | null = null;
let abortController: AbortController | null = null;
let nextId = 1;

export function getLlmInstallStatus(): LlmInstallTaskSnapshot | null {
  return current;
}

export interface StartLlmInstallParams {
  kind: InstallKind;
  model: LlmModelId;
  /** Source path for symlink / copy. */
  srcPath?: string;
  /** Mirror for download. */
  mirror?: LlmMirror;
}

/**
 * Kick off a new install. Returns immediately with the task snapshot in
 * 'running' state; the actual work runs in the background. Throws
 * LlmInstallBusyError if another install is already running.
 */
export function startLlmInstall(params: StartLlmInstallParams): LlmInstallTaskSnapshot {
  if (current && current.state === 'running') {
    throw new LlmInstallBusyError();
  }

  const snapshot: LlmInstallTaskSnapshot = {
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
  // the same object the renderer reads through `getLlmInstallStatus()`.
  void (async () => {
    try {
      if (params.kind === 'symlink') {
        if (!params.srcPath) throw new Error('srcPath required for symlink');
        const { destPath } = await installLlmBySymlink(params.srcPath, params.model);
        snapshot.destPath = destPath;
      } else if (params.kind === 'copy') {
        if (!params.srcPath) throw new Error('srcPath required for copy');
        const { destPath } = await installLlmByCopy(params.srcPath, params.model);
        snapshot.destPath = destPath;
      } else {
        const mirror: LlmMirror = params.mirror ?? 'huggingface';
        const { destPath } = await installLlmByDownload(params.model, mirror, {
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
export function abortLlmInstall(): boolean {
  if (!abortController) return false;
  abortController.abort();
  return true;
}

export { LlmInstallBusyError };
