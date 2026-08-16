/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Singleton tracker for the in-progress SenseVoice model download.
 * Same pattern as whisperInstallTask.ts: one task at a time, snapshot
 * mutated in place, renderer polls getSenseVoiceInstallStatus().
 *
 * Desktop-only in practice — the install target lives under
 * $SUBCAST_HOME, which only exists when Electron booted Nitro.
 */

import {
  installSenseVoiceByDownload,
} from '../../desktop/modelManager/senseVoiceInstall';
import type { SenseVoiceInstallSnapshot } from '../../shared/installContracts';

export type SenseVoiceInstallTaskSnapshot = SenseVoiceInstallSnapshot;

export class SenseVoiceInstallBusyError extends Error {
  constructor() {
    super('BUSY');
    this.name = 'SenseVoiceInstallBusyError';
  }
}

let current: SenseVoiceInstallTaskSnapshot | null = null;
let abortController: AbortController | null = null;
let nextId = 1;

export function getSenseVoiceInstallStatus(): SenseVoiceInstallTaskSnapshot | null {
  return current;
}

export function startSenseVoiceInstall(): SenseVoiceInstallTaskSnapshot {
  if (current && current.state === 'running') {
    throw new SenseVoiceInstallBusyError();
  }
  const home = process.env.SUBCAST_HOME;
  if (!home) throw new Error('SENSE_VOICE_INSTALL_DESKTOP_ONLY');

  const snapshot: SenseVoiceInstallTaskSnapshot = {
    id: nextId++,
    kind: 'download',
    state: 'running',
    startedAt: Date.now(),
  };
  current = snapshot;

  const controller = new AbortController();
  abortController = controller;

  void (async () => {
    try {
      const { destDir } = await installSenseVoiceByDownload(home, {
        signal: controller.signal,
        onProgress: (p) => { snapshot.progress = p; },
      });
      snapshot.destPath = destDir;
      snapshot.state = 'success';
    } catch (err) {
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

export function abortSenseVoiceInstall(): boolean {
  if (!abortController) return false;
  abortController.abort();
  return true;
}
