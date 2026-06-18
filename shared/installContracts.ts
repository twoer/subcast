/* SPDX-License-Identifier: Apache-2.0 */

import type { LlmMirror, LlmModelId } from './llmModels';
import type { WhisperModelName } from './whisperModels';

export const INSTALL_KINDS = ['symlink', 'copy', 'download'] as const;
export type InstallKind = (typeof INSTALL_KINDS)[number];

export const INSTALL_STATES = ['running', 'success', 'error', 'canceled'] as const;
export type InstallState = (typeof INSTALL_STATES)[number];

export const INSTALL_MIRRORS = ['huggingface', 'hf-mirror', 'auto'] as const;
export type InstallMirror = (typeof INSTALL_MIRRORS)[number];

export interface DownloadProgress {
  bytesDownloaded: number;
  bytesTotal: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface InstallTaskSnapshotBase {
  id: number;
  kind: InstallKind;
  mirror?: InstallMirror;
  state: InstallState;
  progress?: DownloadProgress;
  destPath?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface WhisperInstallSnapshot extends InstallTaskSnapshotBase {
  model: WhisperModelName;
}

export interface LlmInstallSnapshot extends InstallTaskSnapshotBase {
  model: LlmModelId;
  mirror?: LlmMirror;
}

export function isInstallKind(value: unknown): value is InstallKind {
  return typeof value === 'string' && (INSTALL_KINDS as readonly string[]).includes(value);
}

export function isInstallMirror(value: unknown): value is InstallMirror {
  return typeof value === 'string' && (INSTALL_MIRRORS as readonly string[]).includes(value);
}
