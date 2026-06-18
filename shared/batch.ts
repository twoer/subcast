/* SPDX-License-Identifier: Apache-2.0 */

export type BatchJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type BatchItemStatus = BatchJobStatus;
export type BatchStep = 'transcribe' | 'translate' | 'insights' | 'diarize';
export type BatchStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface BatchOptions {
  whisperModel: string;
  targetLangs: string[];
  insights: boolean;
  insightLanguage?: 'zh-CN' | 'en';
  diarize: boolean;
  diarizeTopK?: number;
}

export interface BatchStepStatus {
  transcribe?: BatchStepState;
  translate?: Record<string, BatchStepState>;
  insights?: BatchStepState;
  diarize?: BatchStepState;
}

export interface BatchJobSummary {
  id: string;
  name: string;
  status: BatchJobStatus;
  preset: string;
  options: BatchOptions;
  totalItems: number;
  doneItems: number;
  failedItems: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  errorMsg: string | null;
}

export interface BatchItemSummary {
  id: string;
  batchId: string;
  videoSha: string;
  videoName: string;
  status: BatchItemStatus;
  currentStep: BatchStep | null;
  stepStatus: BatchStepStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  errorMsg: string | null;
}

export interface BatchJobDetail extends BatchJobSummary {
  items: BatchItemSummary[];
}
