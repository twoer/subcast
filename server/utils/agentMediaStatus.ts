/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getDb, SUBCAST_PATHS } from './db';
import type { InsightTaskRow, TaskStatus, VideoRow } from '../types/db';

export type AgentRecipe = 'generic-archive-pack' | 'creator-brief' | 'meeting-notes';
export type AgentLanguage = 'zh-CN' | 'en';
export type AgentMediaPhase =
  | 'media_missing'
  | 'transcribe_needed'
  | 'transcribe_pending'
  | 'transcribe_failed'
  | 'insights_needed'
  | 'insights_pending'
  | 'insights_failed'
  | 'bundle_ready';
export type AgentMediaNextAction =
  | 'import_media'
  | 'start_transcribe'
  | 'wait_for_transcribe'
  | 'retry_transcribe'
  | 'start_insights'
  | 'wait_for_insights'
  | 'retry_insights'
  | 'export_bundle';

const HASH_PREFIX_RE = /^[0-9a-f]{12,64}$/i;
const INSIGHT_RECIPES = new Set<AgentRecipe>(['creator-brief', 'meeting-notes']);

interface TranscribeTaskStatus {
  status: TaskStatus;
  errorCode: string | null;
}

interface InsightTaskStatus {
  status: InsightTaskRow['status'];
  errorCode: string | null;
  uiLanguage: AgentLanguage;
}

export interface AgentMediaStatus {
  ok: true;
  recipe: AgentRecipe;
  language: AgentLanguage;
  hash: string;
  hashPrefix: string;
  title: string;
  ext: string;
  durationS: number | null;
  sourceNameRedacted: true;
  phase: AgentMediaPhase;
  nextAction: AgentMediaNextAction;
  hasMediaFile: boolean;
  hasTranscript: boolean;
  hasInsights: boolean;
  transcribeStatus: TaskStatus | null;
  transcribeErrorCode: string | null;
  insightStatus: InsightTaskRow['status'] | null;
  insightErrorCode: string | null;
  missingSteps: Array<'media' | 'transcript' | 'insights'>;
}

export class AgentMediaStatusError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = code;
  }
}

export function isAgentRecipe(value: unknown): value is AgentRecipe {
  return value === 'generic-archive-pack' || value === 'creator-brief' || value === 'meeting-notes';
}

export function isAgentLanguage(value: unknown): value is AgentLanguage {
  return value === 'zh-CN' || value === 'en';
}

function resolveVideo(hashOrPrefix: string): Pick<VideoRow, 'sha256' | 'ext' | 'duration_s'> {
  if (!HASH_PREFIX_RE.test(hashOrPrefix)) throw new AgentMediaStatusError('BAD_HASH');
  const rows = getDb().prepare(
    `SELECT sha256, ext, duration_s
     FROM videos
     WHERE sha256 LIKE ? AND COALESCE(deleted_at, 0) = 0
     ORDER BY last_opened_at DESC
     LIMIT 2`,
  ).all(`${hashOrPrefix.toLowerCase()}%`) as Array<Pick<VideoRow, 'sha256' | 'ext' | 'duration_s'>>;
  if (rows.length > 1) throw new AgentMediaStatusError('AMBIGUOUS_HASH');
  const video = rows[0];
  if (!video) throw new AgentMediaStatusError('VIDEO_NOT_FOUND');
  return video;
}

function latestTranscribeTask(hash: string): TranscribeTaskStatus | null {
  const row = getDb().prepare(
    `SELECT status, error_code
     FROM transcribe_tasks
     WHERE video_sha = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(hash) as { status: TaskStatus; error_code: string | null } | undefined;
  return row ? { status: row.status, errorCode: row.error_code } : null;
}

function latestInsightTask(hash: string, lang: AgentLanguage): InsightTaskStatus | null {
  const row = getDb().prepare(
    `SELECT status, error_code, ui_language
     FROM insight_tasks
     WHERE video_sha = ? AND ui_language = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(hash, lang) as { status: InsightTaskRow['status']; error_code: string | null; ui_language: AgentLanguage } | undefined;
  return row ? { status: row.status, errorCode: row.error_code, uiLanguage: row.ui_language } : null;
}

function hasInsightArtifact(hash: string, lang: AgentLanguage): boolean {
  const artifactDir = join(SUBCAST_PATHS.cache, hash, 'artifacts', 'insight');
  const pointerPath = join(artifactDir, `latest-${lang}.json`);
  if (existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
        fingerprint?: string;
        filename?: string;
      };
      if (pointer.fingerprint && pointer.filename) {
        const artifactPath = join(artifactDir, basename(pointer.filename));
        if (existsSync(artifactPath)) return true;
      }
    } catch {
      return false;
    }
  }
  return existsSync(join(SUBCAST_PATHS.cache, hash, 'insights.json'));
}

function hasAnyInsightArtifact(hash: string): boolean {
  const artifactDir = join(SUBCAST_PATHS.cache, hash, 'artifacts', 'insight');
  if (!existsSync(artifactDir)) return existsSync(join(SUBCAST_PATHS.cache, hash, 'insights.json'));
  try {
    return readdirSync(artifactDir).some((name) => /^latest-(zh-CN|en)\.json$/.test(name))
      || existsSync(join(SUBCAST_PATHS.cache, hash, 'insights.json'));
  } catch {
    return existsSync(join(SUBCAST_PATHS.cache, hash, 'insights.json'));
  }
}

export function getAgentMediaStatus(input: {
  hash: string;
  recipe?: AgentRecipe;
  language?: AgentLanguage;
}): AgentMediaStatus {
  const recipe = input.recipe ?? 'generic-archive-pack';
  const language = input.language ?? 'zh-CN';
  const video = resolveVideo(input.hash);
  const hash = video.sha256;
  const mediaPath = join(SUBCAST_PATHS.videos, `${hash}${video.ext}`);
  const transcriptPath = join(SUBCAST_PATHS.cache, hash, 'original.vtt');
  const transcribeTask = latestTranscribeTask(hash);
  const insightTask = latestInsightTask(hash, language);
  const hasMediaFile = existsSync(mediaPath);
  const hasTranscript = existsSync(transcriptPath);
  const hasInsights = hasInsightArtifact(hash, language) || (!INSIGHT_RECIPES.has(recipe) && hasAnyInsightArtifact(hash));
  const missingSteps: AgentMediaStatus['missingSteps'] = [];

  let phase: AgentMediaPhase;
  let nextAction: AgentMediaNextAction;

  if (!hasMediaFile) {
    missingSteps.push('media');
    phase = 'media_missing';
    nextAction = 'import_media';
  } else if (!hasTranscript) {
    missingSteps.push('transcript');
    if (transcribeTask?.status === 'queued' || transcribeTask?.status === 'running') {
      phase = 'transcribe_pending';
      nextAction = 'wait_for_transcribe';
    } else if (transcribeTask?.status === 'failed') {
      phase = 'transcribe_failed';
      nextAction = 'retry_transcribe';
    } else {
      phase = 'transcribe_needed';
      nextAction = 'start_transcribe';
    }
  } else if (INSIGHT_RECIPES.has(recipe) && !hasInsights) {
    missingSteps.push('insights');
    if (insightTask?.status === 'queued' || insightTask?.status === 'running') {
      phase = 'insights_pending';
      nextAction = 'wait_for_insights';
    } else if (insightTask?.status === 'error') {
      phase = 'insights_failed';
      nextAction = 'retry_insights';
    } else {
      phase = 'insights_needed';
      nextAction = 'start_insights';
    }
  } else {
    phase = 'bundle_ready';
    nextAction = 'export_bundle';
  }

  return {
    ok: true,
    recipe,
    language,
    hash,
    hashPrefix: hash.slice(0, 12),
    title: `subcast-${hash.slice(0, 12)}`,
    ext: video.ext,
    durationS: video.duration_s,
    sourceNameRedacted: true,
    phase,
    nextAction,
    hasMediaFile,
    hasTranscript,
    hasInsights,
    transcribeStatus: transcribeTask?.status ?? null,
    transcribeErrorCode: transcribeTask?.errorCode ?? null,
    insightStatus: insightTask?.status ?? null,
    insightErrorCode: insightTask?.errorCode ?? null,
    missingSteps,
  };
}
