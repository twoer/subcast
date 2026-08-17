/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { SUBCAST_PATHS } from './db';

export interface InsightArtifactEnvelope<T = unknown> {
  kind: 'insight';
  videoSha: string;
  uiLanguage: 'zh-CN' | 'en';
  fingerprint: string;
  generatedAt: number;
  payload: T;
}

interface InsightLatestPointer {
  kind: 'insight';
  uiLanguage: 'zh-CN' | 'en';
  fingerprint: string;
  filename: string;
  updatedAt: number;
}

function insightArtifactDir(videoSha: string): string {
  return join(SUBCAST_PATHS.cache, videoSha, 'artifacts', 'insight');
}

export function insightArtifactPath(videoSha: string, fingerprint: string): string {
  return join(insightArtifactDir(videoSha), `${fingerprint}.json`);
}

export function insightLatestPointerPath(videoSha: string, uiLanguage: 'zh-CN' | 'en'): string {
  return join(insightArtifactDir(videoSha), `latest-${uiLanguage}.json`);
}

export function writeInsightArtifact<T>(
  videoSha: string,
  uiLanguage: 'zh-CN' | 'en',
  fingerprint: string,
  payload: T,
): InsightArtifactEnvelope<T> {
  const dir = insightArtifactDir(videoSha);
  mkdirSync(dir, { recursive: true });
  const generatedAt = Date.now();
  const envelope: InsightArtifactEnvelope<T> = {
    kind: 'insight',
    videoSha,
    uiLanguage,
    fingerprint,
    generatedAt,
    payload,
  };
  const filename = `${fingerprint}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(envelope, null, 2));
  const pointer: InsightLatestPointer = {
    kind: 'insight',
    uiLanguage,
    fingerprint,
    filename,
    updatedAt: generatedAt,
  };
  writeFileSync(insightLatestPointerPath(videoSha, uiLanguage), JSON.stringify(pointer, null, 2));
  return envelope;
}

export function readInsightArtifact<T = unknown>(
  videoSha: string,
  fingerprint: string,
): InsightArtifactEnvelope<T> | null {
  const path = insightArtifactPath(videoSha, fingerprint);
  if (!existsSync(path)) return null;
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as InsightArtifactEnvelope<T>;
  if (
    envelope.kind !== 'insight' ||
    envelope.videoSha !== videoSha ||
    envelope.fingerprint !== fingerprint
  ) {
    return null;
  }
  return envelope;
}

export function readLatestInsightArtifact<T = unknown>(
  videoSha: string,
  uiLanguage: 'zh-CN' | 'en',
  expectedFingerprint: string,
): InsightArtifactEnvelope<T> | null {
  const pointerPath = insightLatestPointerPath(videoSha, uiLanguage);
  if (!existsSync(pointerPath)) return null;
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as InsightLatestPointer;
  if (
    pointer.kind !== 'insight' ||
    pointer.uiLanguage !== uiLanguage ||
    pointer.fingerprint !== expectedFingerprint ||
    basename(pointer.filename) !== `${expectedFingerprint}.json`
  ) {
    return null;
  }
  const envelope = readInsightArtifact<T>(videoSha, expectedFingerprint);
  if (!envelope || envelope.uiLanguage !== uiLanguage) return null;
  return envelope;
}

export function deleteInsightArtifact(
  videoSha: string,
  uiLanguage: 'zh-CN' | 'en',
  fingerprint: string,
): void {
  const artifactPath = insightArtifactPath(videoSha, fingerprint);
  if (existsSync(artifactPath)) unlinkSync(artifactPath);

  const pointerPath = insightLatestPointerPath(videoSha, uiLanguage);
  if (!existsSync(pointerPath)) return;
  try {
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as InsightLatestPointer;
    if (pointer.fingerprint === fingerprint) unlinkSync(pointerPath);
  } catch {
    unlinkSync(pointerPath);
  }
}
