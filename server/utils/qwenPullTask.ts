/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Singleton tracker for the in-progress Qwen pull. Mirrors
 * `whisperInstallTask.ts` — one task at a time, persists for the lifetime
 * of the Nitro process so the wizard can leave Step 3 and come back.
 */

import {
  pullQwenModel,
  QWEN_MODELS,
  type QwenPullProgress,
  type QwenVariant,
} from '../../desktop/modelManager/qwen';

export type QwenPullState = 'running' | 'success' | 'error';

export interface QwenPullSnapshot {
  id: number;
  variant: QwenVariant;
  tag: string;
  state: QwenPullState;
  progress?: QwenPullProgress;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

class QwenPullBusyError extends Error {
  constructor() {
    super('BUSY');
    this.name = 'QwenPullBusyError';
  }
}

let current: QwenPullSnapshot | null = null;
let abortController: AbortController | null = null;
let nextId = 1;

export function getQwenPullStatus(): QwenPullSnapshot | null {
  return current;
}

export function startQwenPull(variant: QwenVariant): QwenPullSnapshot {
  if (current && current.state === 'running') {
    throw new QwenPullBusyError();
  }

  const snapshot: QwenPullSnapshot = {
    id: nextId++,
    variant,
    tag: QWEN_MODELS[variant].tag,
    state: 'running',
    startedAt: Date.now(),
  };
  current = snapshot;

  const controller = new AbortController();
  abortController = controller;

  void (async () => {
    try {
      await pullQwenModel({
        variant,
        signal: controller.signal,
        onProgress: (p) => { snapshot.progress = p; },
      });
      snapshot.state = 'success';
    } catch (err) {
      snapshot.state = 'error';
      snapshot.error = err instanceof Error ? err.message : String(err);
    } finally {
      snapshot.finishedAt = Date.now();
      if (abortController === controller) abortController = null;
    }
  })();

  return snapshot;
}

export function abortQwenPull(): boolean {
  if (!abortController) return false;
  abortController.abort();
  return true;
}

export { QwenPullBusyError };
