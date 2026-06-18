/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { BatchItemSummary, BatchStepStatus } from '../types/batch';
import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { llmQueue, transcribeQueue, translateQueue } from './queue';
import { ensureDiarizeTask } from './diarize/tasks';
import { runDiarize } from './diarize/diarize';
import {
  getBatchJob,
  markBatchStatus,
  markItemStatus,
  markItemStep,
  recomputeBatchStatus,
} from './batchRepo';

const activeBatches = new Set<string>();

export interface BatchRunnerAdapter {
  hasTranscript(videoSha: string): boolean;
  hasTranslation(videoSha: string, lang: string): boolean;
  hasInsights(videoSha: string): boolean;
  hasDiarization(videoSha: string): boolean;
  runTranscribe(videoSha: string, model: string): Promise<void>;
  runTranslate(videoSha: string, lang: string): Promise<void>;
  runInsights(videoSha: string, uiLanguage: 'zh-CN' | 'en'): Promise<void>;
  runDiarize(videoSha: string, topK?: number): Promise<void>;
}

interface RunBatchOptions {
  adapter?: BatchRunnerAdapter;
}

function terminalFrameError(frame: { event: string; data?: unknown }): Error | null {
  if (frame.event !== 'error') return null;
  const data = frame.data as { msg?: string; message?: string; code?: string } | undefined;
  return new Error(data?.msg ?? data?.message ?? data?.code ?? 'task failed');
}

async function waitForFrames(frames: AsyncIterable<{ event: string; data?: unknown }>): Promise<void> {
  for await (const frame of frames) {
    const err = terminalFrameError(frame);
    if (err) throw err;
    if (frame.event === 'done') return;
  }
}

export const defaultBatchRunnerAdapter: BatchRunnerAdapter = {
  hasTranscript(videoSha) {
    return existsSync(join(SUBCAST_PATHS.cache, videoSha, 'original.vtt'));
  },
  hasTranslation(videoSha, lang) {
    return existsSync(join(SUBCAST_PATHS.cache, videoSha, `${lang}.vtt`));
  },
  hasInsights(videoSha) {
    return existsSync(join(SUBCAST_PATHS.cache, videoSha, 'insights.json'));
  },
  hasDiarization(videoSha) {
    const row = getDb()
      .prepare(`SELECT status FROM diarize_tasks WHERE video_sha = ?`)
      .get(videoSha) as { status: string } | undefined;
    return row?.status === 'done';
  },
  async runTranscribe(videoSha, model) {
    const task = transcribeQueue.ensureTask(videoSha, model);
    await transcribeQueue.tryStartNext();
    await waitForFrames(transcribeQueue.attach(task.id));
  },
  async runTranslate(videoSha, lang) {
    const task = translateQueue.ensureTask(videoSha, lang);
    await translateQueue.tryStartNext();
    await waitForFrames(translateQueue.attach(task.id));
  },
  async runInsights(videoSha, uiLanguage) {
    const task = llmQueue.ensureInsightTask(videoSha, uiLanguage, 'llm');
    await llmQueue.tryStartNext();
    await waitForFrames(llmQueue.attach(task.id));
  },
  async runDiarize(videoSha, topK) {
    const task = ensureDiarizeTask(videoSha, { topK });
    if (!task.alreadyRunning) {
      void runDiarize(videoSha, task.taskId, { topK }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logEvent({
          level: 'error',
          event: 'batch_diarize_run_failed',
          videoSha,
          taskId: task.taskId,
          message,
        });
        getDb()
          .prepare(`UPDATE diarize_tasks SET status='failed', error_msg=?, completed_at=? WHERE id=?`)
          .run(message, Date.now(), task.taskId);
      });
    }
    await waitForDiarizeDone(videoSha);
  },
};

async function waitForDiarizeDone(videoSha: string): Promise<void> {
  while (true) {
    const row = getDb()
      .prepare(`SELECT status, error_msg FROM diarize_tasks WHERE video_sha = ?`)
      .get(videoSha) as { status: string; error_msg: string | null } | undefined;
    if (row?.status === 'done') return;
    if (row?.status === 'failed') throw new Error(row.error_msg ?? 'diarize failed');
    if (!row) throw new Error('diarize task missing');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function isCanceled(batchId: string): boolean {
  const row = getDb()
    .prepare(`SELECT status FROM batch_jobs WHERE id = ?`)
    .get(batchId) as { status: string } | undefined;
  return row?.status === 'canceled';
}

async function runItem(
  item: BatchItemSummary,
  stepStatus: BatchStepStatus,
  adapter: BatchRunnerAdapter,
  options: ReturnType<typeof getBatchJob> extends infer T
    ? T extends { options: infer O } ? O : never
    : never,
): Promise<void> {
  if (!adapter.hasTranscript(item.videoSha)) {
    markItemStep(item.id, 'transcribe', 'running');
    await adapter.runTranscribe(item.videoSha, options.whisperModel);
    markItemStep(item.id, 'transcribe', 'done');
  } else if (stepStatus.transcribe !== 'done') {
    markItemStep(item.id, 'transcribe', 'skipped');
  }

  for (const lang of options.targetLangs) {
    if (adapter.hasTranslation(item.videoSha, lang)) {
      markItemStep(item.id, 'translate', 'skipped', lang);
      continue;
    }
    markItemStep(item.id, 'translate', 'running', lang);
    await adapter.runTranslate(item.videoSha, lang);
    markItemStep(item.id, 'translate', 'done', lang);
  }

  if (options.insights) {
    if (adapter.hasInsights(item.videoSha)) {
      markItemStep(item.id, 'insights', 'skipped');
    } else {
      markItemStep(item.id, 'insights', 'running');
      await adapter.runInsights(item.videoSha, options.insightLanguage ?? 'zh-CN');
      markItemStep(item.id, 'insights', 'done');
    }
  }

  if (options.diarize) {
    if (adapter.hasDiarization(item.videoSha)) {
      markItemStep(item.id, 'diarize', 'skipped');
    } else {
      markItemStep(item.id, 'diarize', 'running');
      await adapter.runDiarize(item.videoSha, options.diarizeTopK);
      markItemStep(item.id, 'diarize', 'done');
    }
  }
}

export async function runBatchOnce(
  batchId: string,
  opts: RunBatchOptions = {},
): Promise<void> {
  const adapter = opts.adapter ?? defaultBatchRunnerAdapter;
  const job = getBatchJob(batchId);
  if (!job) throw new Error('BATCH_NOT_FOUND');
  if (job.status === 'canceled') return;

  markBatchStatus(batchId, 'running');
  for (const item of job.items) {
    if (isCanceled(batchId)) return;
    if (item.status === 'completed' || item.status === 'canceled') continue;
    markItemStatus(item.id, 'running');
    try {
      await runItem(item, item.stepStatus, adapter, job.options);
      markItemStatus(item.id, 'completed');
    } catch (err) {
      markItemStatus(item.id, 'failed', err instanceof Error ? err.message : String(err));
      logEvent({
        level: 'warn',
        event: 'batch_item_failed',
        batchId,
        itemId: item.id,
        videoSha: item.videoSha,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      recomputeBatchStatus(batchId);
    }
  }
  recomputeBatchStatus(batchId);
}

export async function startBatch(batchId: string): Promise<void> {
  if (activeBatches.has(batchId)) return;
  activeBatches.add(batchId);
  try {
    await runBatchOnce(batchId);
  } finally {
    activeBatches.delete(batchId);
  }
}

export function cancelBatchChildren(batchId: string): void {
  const job = getBatchJob(batchId);
  if (!job) return;
  const db = getDb();
  for (const item of job.items) {
    if (item.status !== 'queued' && item.status !== 'running') continue;
    const transcribes = db
      .prepare(`SELECT id FROM transcribe_tasks WHERE video_sha = ? AND status IN ('queued','running')`)
      .all(item.videoSha) as Array<{ id: string }>;
    for (const task of transcribes) transcribeQueue.cancel(task.id);

    const translates = db
      .prepare(`SELECT id FROM translate_tasks WHERE video_sha = ? AND status IN ('queued','running')`)
      .all(item.videoSha) as Array<{ id: string }>;
    for (const task of translates) translateQueue.cancel(task.id);

    const insights = db
      .prepare(`SELECT id FROM insight_tasks WHERE video_sha = ? AND status IN ('queued','running')`)
      .all(item.videoSha) as Array<{ id: string }>;
    for (const task of insights) llmQueue.cancel(task.id);

    db.prepare(
      `UPDATE diarize_tasks
       SET status='failed',
           error_code='CANCELED',
           error_msg='Canceled by user',
           completed_at=?
       WHERE video_sha = ? AND status IN ('pending','running')`,
    ).run(Date.now(), item.videoSha);
  }
}
