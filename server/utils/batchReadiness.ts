/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BatchOptions, BatchStep } from '../types/batch';
import { getDb, SUBCAST_PATHS } from './db';
import { loadSettings } from './settings';
import { buildInsightArtifactFingerprint } from './artifactFingerprint';
import { readLatestInsightArtifact } from './artifactStore';

export interface BatchWorkItem {
  videoSha: string;
  missingSteps: BatchStep[];
}

export interface BatchWorkPlan {
  items: BatchWorkItem[];
  totalVideos: number;
  readyVideos: number;
}

function hasTranscript(videoSha: string): boolean {
  return existsSync(join(SUBCAST_PATHS.cache, videoSha, 'original.vtt'));
}

function hasTranslation(videoSha: string, lang: string): boolean {
  return existsSync(join(SUBCAST_PATHS.cache, videoSha, `${lang}.vtt`));
}

function hasInsights(videoSha: string, uiLanguage: 'zh-CN' | 'en'): boolean {
  const transcriptPath = join(SUBCAST_PATHS.cache, videoSha, 'original.vtt');
  const legacyPath = join(SUBCAST_PATHS.cache, videoSha, 'insights.json');
  if (!existsSync(transcriptPath)) return existsSync(legacyPath);
  const model = loadSettings().llmModel;
  if (!model) return existsSync(legacyPath);
  const transcript = readFileSync(transcriptPath, 'utf8');
  const fingerprint = buildInsightArtifactFingerprint({
    videoSha,
    transcript,
    uiLanguage,
    modelId: model,
  });
  return readLatestInsightArtifact(videoSha, uiLanguage, fingerprint) !== null ||
    existsSync(legacyPath);
}

function hasDiarization(videoSha: string): boolean {
  const row = getDb()
    .prepare(`SELECT status FROM diarize_tasks WHERE video_sha = ?`)
    .get(videoSha) as { status: string } | undefined;
  return row?.status === 'done';
}

export function missingBatchSteps(videoSha: string, options: BatchOptions): BatchStep[] {
  const missing: BatchStep[] = [];
  if (!hasTranscript(videoSha)) missing.push('transcribe');
  if (options.targetLangs.some((lang) => !hasTranslation(videoSha, lang))) {
    missing.push('translate');
  }
  if (options.insights && !hasInsights(videoSha, options.insightLanguage ?? 'zh-CN')) {
    missing.push('insights');
  }
  if (options.diarize && !hasDiarization(videoSha)) missing.push('diarize');
  return missing;
}

export function planBatchWork(videoShas: string[], options: BatchOptions): BatchWorkPlan {
  const items = videoShas
    .map((videoSha) => ({ videoSha, missingSteps: missingBatchSteps(videoSha, options) }))
    .filter((item) => item.missingSteps.length > 0);
  return {
    items,
    totalVideos: videoShas.length,
    readyVideos: videoShas.length - items.length,
  };
}
