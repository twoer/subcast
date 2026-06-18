/* SPDX-License-Identifier: Apache-2.0 */
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getDb, SUBCAST_PATHS } from './db';
import { logEvent } from './log';
import { generateWaveform } from './waveform';

export const BATCH_STAGE_ID_RE = /^[0-9a-f-]{36}$/i;
export const VIDEO_EXT = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a'] as const;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export interface BatchStageMeta {
  id: string;
  sha256: string;
  originalName: string;
  ext: string;
  sizeBytes: number;
  stagedAt: number;
}

export interface BatchStageResult {
  stageId: string | null;
  hash: string;
  originalName: string;
  ext: string;
  sizeBytes: number;
  existed: boolean;
}

function stageDir(): string {
  return join(SUBCAST_PATHS.tmp, 'batch-stage');
}

function stageMediaPath(stageId: string, ext: string): string {
  return join(stageDir(), `${stageId}${ext}`);
}

function stageMetaPath(stageId: string): string {
  return join(stageDir(), `${stageId}.json`);
}

function prewarmWaveform(finalPath: string, sha: string): void {
  void generateWaveform(finalPath)
    .then(async (peaks) => {
      const cacheDir = join(SUBCAST_PATHS.cache, sha);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        join(cacheDir, 'waveform.json'),
        JSON.stringify({ version: 1, peaks }),
      );
      getDb().prepare('UPDATE videos SET has_waveform = 1 WHERE sha256 = ?').run(sha);
    })
    .catch((err: unknown) => {
      logEvent({
        level: 'warn',
        event: 'waveform_prewarm_failed',
        sha,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export async function stageBatchVideo(file: File): Promise<BatchStageResult> {
  const ext = extname(file.name).toLowerCase();
  const stageId = randomUUID();
  await mkdir(stageDir(), { recursive: true });
  const tmpPath = stageMediaPath(stageId, ext);
  const hash = createHash('sha256');
  const writeFileStream = createWriteStream(tmpPath);

  await pipeline(
    Readable.fromWeb(file.stream() as never),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        writeFileStream.write(chunk, cb);
      },
      final(cb) {
        writeFileStream.end(cb);
      },
    }),
  );

  const sha = hash.digest('hex');
  const db = getDb();
  const existing = db
    .prepare('SELECT sha256 FROM videos WHERE sha256 = ? AND deleted_at IS NULL')
    .get(sha) as { sha256: string } | undefined;
  if (existing) {
    await unlink(tmpPath).catch(() => { /* already gone */ });
    return {
      stageId: null,
      hash: sha,
      originalName: file.name,
      ext,
      sizeBytes: file.size,
      existed: true,
    };
  }

  const meta: BatchStageMeta = {
    id: stageId,
    sha256: sha,
    originalName: file.name,
    ext,
    sizeBytes: file.size,
    stagedAt: Date.now(),
  };
  await writeFile(stageMetaPath(stageId), JSON.stringify(meta), 'utf8');
  return {
    stageId,
    hash: sha,
    originalName: file.name,
    ext,
    sizeBytes: file.size,
    existed: false,
  };
}

export async function commitBatchStage(stageId: string): Promise<BatchStageMeta> {
  const meta = JSON.parse(await readFile(stageMetaPath(stageId), 'utf8')) as BatchStageMeta;
  const tmpPath = stageMediaPath(stageId, meta.ext);
  const finalPath = join(SUBCAST_PATHS.videos, `${meta.sha256}${meta.ext}`);
  await mkdir(SUBCAST_PATHS.videos, { recursive: true });

  try {
    await rename(tmpPath, finalPath);
  } catch {
    await copyFile(tmpPath, finalPath);
    await unlink(tmpPath).catch(() => { /* swallow */ });
  }
  await unlink(stageMetaPath(stageId)).catch(() => { /* swallow */ });

  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET last_opened_at = excluded.last_opened_at, deleted_at = NULL`,
    )
    .run(meta.sha256, meta.originalName, meta.ext, meta.sizeBytes, now, now);
  prewarmWaveform(finalPath, meta.sha256);
  return meta;
}

export async function cleanupBatchStages(stageIds: string[]): Promise<void> {
  await Promise.all(
    stageIds.map(async (stageId) => {
      if (!BATCH_STAGE_ID_RE.test(stageId)) return;
      let ext = '';
      try {
        const meta = JSON.parse(await readFile(stageMetaPath(stageId), 'utf8')) as BatchStageMeta;
        ext = meta.ext;
      } catch {
        /* missing meta */
      }
      await rm(stageMetaPath(stageId), { force: true });
      if (ext) await rm(stageMediaPath(stageId, ext), { force: true });
    }),
  );
}
