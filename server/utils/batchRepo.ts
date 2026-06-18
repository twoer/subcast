/* SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';

import type {
  BatchItemStatus,
  BatchJobDetail,
  BatchJobStatus,
  BatchJobSummary,
  BatchOptions,
  BatchStep,
  BatchStepState,
  BatchStepStatus,
} from '../types/batch';
import { getDb } from './db';

interface BatchJobRow {
  id: string;
  name: string;
  status: BatchJobStatus;
  preset: string;
  options_json: string;
  total_items: number;
  done_items: number;
  failed_items: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_msg: string | null;
}

interface BatchItemRow {
  id: string;
  batch_id: string;
  video_sha: string;
  video_name: string | null;
  status: BatchItemStatus;
  current_step: BatchStep | null;
  step_status_json: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_msg: string | null;
}

export function initialStepStatus(options: BatchOptions): BatchStepStatus {
  const status: BatchStepStatus = { transcribe: 'pending' };
  if (options.targetLangs.length > 0) {
    status.translate = Object.fromEntries(
      options.targetLangs.map((lang) => [lang, 'pending' satisfies BatchStepState]),
    );
  }
  status.insights = options.insights ? 'pending' : 'skipped';
  status.diarize = options.diarize ? 'pending' : 'skipped';
  return status;
}

function parseOptions(raw: string): BatchOptions {
  return JSON.parse(raw) as BatchOptions;
}

function parseStepStatus(raw: string): BatchStepStatus {
  return JSON.parse(raw) as BatchStepStatus;
}

function mapJob(row: BatchJobRow): BatchJobSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    preset: row.preset,
    options: parseOptions(row.options_json),
    totalItems: row.total_items,
    doneItems: row.done_items,
    failedItems: row.failed_items,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMsg: row.error_msg,
  };
}

function mapItem(row: BatchItemRow): BatchJobDetail['items'][number] {
  return {
    id: row.id,
    batchId: row.batch_id,
    videoSha: row.video_sha,
    videoName: row.video_name ?? row.video_sha.slice(0, 12),
    status: row.status,
    currentStep: row.current_step,
    stepStatus: parseStepStatus(row.step_status_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMsg: row.error_msg,
  };
}

export function createBatchJob(input: {
  name: string;
  preset: string;
  options: BatchOptions;
  videoShas: string[];
}): { id: string } {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const stepStatus = JSON.stringify(initialStepStatus(input.options));

  db.transaction(() => {
    db.prepare(
      `INSERT INTO batch_jobs
        (id, name, status, preset, options_json, total_items, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(id, input.name, input.preset, JSON.stringify(input.options), input.videoShas.length, now);

    const insertItem = db.prepare(
      `INSERT INTO batch_items
        (id, batch_id, video_sha, status, step_status_json, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    );
    for (const videoSha of input.videoShas) {
      insertItem.run(randomUUID(), id, videoSha, stepStatus, now);
    }
  })();

  return { id };
}

export function listBatchJobs(): BatchJobSummary[] {
  const rows = getDb()
    .prepare(`SELECT * FROM batch_jobs ORDER BY created_at DESC, rowid DESC`)
    .all() as BatchJobRow[];
  return rows.map(mapJob);
}

export function getBatchJob(id: string): BatchJobDetail | null {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM batch_jobs WHERE id = ?`).get(id) as BatchJobRow | undefined;
  if (!job) return null;
  const items = db
    .prepare(
      `SELECT i.*, COALESCE(v.display_name, v.original_name) AS video_name
       FROM batch_items i
       LEFT JOIN videos v ON v.sha256 = i.video_sha
       WHERE i.batch_id = ?
       ORDER BY i.created_at ASC, i.rowid ASC`,
    )
    .all(id) as BatchItemRow[];
  return { ...mapJob(job), items: items.map(mapItem) };
}

export function markItemStep(
  batchItemId: string,
  step: BatchStep,
  state: BatchStepState,
  lang?: string,
): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT step_status_json FROM batch_items WHERE id = ?`)
    .get(batchItemId) as Pick<BatchItemRow, 'step_status_json'> | undefined;
  if (!row) return;
  const status = parseStepStatus(row.step_status_json);
  if (step === 'translate') {
    if (!lang) throw new Error('markItemStep translate requires lang');
    status.translate = { ...(status.translate ?? {}), [lang]: state };
  } else {
    status[step] = state;
  }
  db.prepare(
    `UPDATE batch_items
     SET current_step = ?, step_status_json = ?
     WHERE id = ?`,
  ).run(step, JSON.stringify(status), batchItemId);
}

export function markItemStatus(
  batchItemId: string,
  status: BatchItemStatus,
  errorMsg?: string,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE batch_items
       SET status = ?,
           started_at = CASE WHEN started_at IS NULL AND ? IN ('running','completed','failed','canceled') THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? IN ('completed','failed','canceled') THEN ? ELSE completed_at END,
           error_msg = CASE WHEN ? IS NOT NULL THEN ? ELSE error_msg END
       WHERE id = ?`,
    )
    .run(status, status, now, status, now, errorMsg ?? null, errorMsg ?? null, batchItemId);
}

export function markBatchStatus(
  batchId: string,
  status: BatchJobStatus,
  errorMsg?: string,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE batch_jobs
       SET status = ?,
           started_at = CASE WHEN started_at IS NULL AND ? IN ('running','completed','failed','canceled') THEN ? ELSE started_at END,
           completed_at = CASE WHEN ? IN ('completed','failed','canceled') THEN ? ELSE completed_at END,
           error_msg = CASE WHEN ? IS NOT NULL THEN ? ELSE error_msg END
       WHERE id = ?`,
    )
    .run(status, status, now, status, now, errorMsg ?? null, errorMsg ?? null, batchId);
}

export function recomputeBatchStatus(batchId: string): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT status FROM batch_items WHERE batch_id = ?`)
    .all(batchId) as Array<{ status: BatchItemStatus }>;
  if (rows.length === 0) return;
  const doneItems = rows.filter((r) => r.status === 'completed').length;
  const failedItems = rows.filter((r) => r.status === 'failed').length;
  const canceledItems = rows.filter((r) => r.status === 'canceled').length;
  const activeItems = rows.filter((r) => r.status === 'running' || r.status === 'queued').length;
  const now = Date.now();

  let status: BatchJobStatus = 'running';
  if (canceledItems === rows.length) status = 'canceled';
  else if (activeItems === 0 && failedItems > 0) status = 'failed';
  else if (activeItems === 0 && doneItems === rows.length) status = 'completed';

  db.prepare(
    `UPDATE batch_jobs
     SET status = ?,
         done_items = ?,
         failed_items = ?,
         started_at = CASE WHEN started_at IS NULL AND ? IN ('running','completed','failed','canceled') THEN ? ELSE started_at END,
         completed_at = CASE WHEN ? IN ('completed','failed','canceled') THEN ? ELSE completed_at END
     WHERE id = ?`,
  ).run(status, doneItems, failedItems, status, now, status, now, batchId);
}

export function cancelBatch(batchId: string): void {
  const db = getDb();
  db.transaction(() => {
    const now = Date.now();
    db.prepare(
      `UPDATE batch_items
       SET status = 'canceled',
           completed_at = ?,
           error_msg = COALESCE(error_msg, 'Canceled by user')
       WHERE batch_id = ? AND status IN ('queued','running')`,
    ).run(now, batchId);
    db.prepare(
      `UPDATE batch_jobs
       SET status = 'canceled',
           completed_at = ?,
           error_msg = COALESCE(error_msg, 'Canceled by user')
       WHERE id = ?`,
    ).run(now, batchId);
  })();
}

export function retryFailedBatchItems(batchId: string): void {
  const db = getDb();
  db.transaction(() => {
    const job = getBatchJob(batchId);
    const resetByItem = new Map(
      job?.items
        .filter((item) => item.status === 'failed')
        .map((item) => [item.id, JSON.stringify(initialStepStatus(job.options))]) ?? [],
    );
    const updateItem = db.prepare(
      `UPDATE batch_items
       SET status = 'queued',
           current_step = NULL,
           step_status_json = ?,
           started_at = NULL,
           completed_at = NULL,
           error_msg = NULL
       WHERE id = ?`,
    );
    for (const [itemId, stepStatus] of resetByItem) {
      updateItem.run(stepStatus, itemId);
    }
    recomputeBatchStatus(batchId);
    const row = db
      .prepare(`SELECT status FROM batch_jobs WHERE id = ?`)
      .get(batchId) as { status: BatchJobStatus } | undefined;
    if (row?.status === 'failed') {
      db.prepare(
        `UPDATE batch_jobs
         SET status = 'queued',
             completed_at = NULL,
             error_msg = NULL
         WHERE id = ?`,
      ).run(batchId);
    }
  })();
}
