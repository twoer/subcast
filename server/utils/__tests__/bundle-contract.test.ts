/* SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-bundle-contract-'));
  process.env.SUBCAST_HOME = join(r, 'home');
  return { tmpRoot: r };
});

/* eslint-disable import/first -- imports must follow vi.hoisted() so SUBCAST_HOME is set first */
import { buildGenericArchiveBundleZip } from '../subcastBundleExport';
import { closeDb, getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const HASH = 'f'.repeat(64);

function scriptPath(name: string): string {
  return resolve(process.cwd(), 'scripts', name);
}

function normalizeManifest(raw: string): Record<string, unknown> {
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  delete manifest.runId;
  delete manifest.generatedAt;
  return manifest;
}

function normalizeSources(raw: string): Record<string, unknown> {
  const sources = JSON.parse(raw) as Record<string, unknown>;
  delete sources.generatedAt;
  return sources;
}

beforeAll(() => {
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:04.000',
      'First cue for bundle contract.',
      '',
      '00:00:10.000 --> 00:00:13.000',
      'Second cue with enough text for review.',
      '',
      '00:00:20.000 --> 00:00:24.000',
      'Final cue closes the sample.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'insights.json'),
    JSON.stringify({
      summary: 'Fixture summary.',
      summaryBullets: ['Fixture point one', 'Fixture point two'],
      chapters: [
        { startMs: 1000, title: 'Opening', description: 'Introduces the topic.' },
        { startMs: 10000, title: 'Middle', description: 'Develops the key point.' },
      ],
    }),
  );
  const artifactDir = join(SUBCAST_PATHS.cache, HASH, 'artifacts', 'insight');
  const artifactFingerprint = 'artifact-fingerprint';
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, `${artifactFingerprint}.json`),
    JSON.stringify({
      kind: 'insight',
      videoSha: HASH,
      uiLanguage: 'zh-CN',
      fingerprint: artifactFingerprint,
      generatedAt: 1_776_144_000_000,
      payload: {
        summary: 'Artifact summary.',
        summaryBullets: ['Artifact point one', 'Artifact point two'],
        chapters: [
          { startMs: 1000, title: 'Opening', description: 'Introduces the topic.' },
          { startMs: 10000, title: 'Middle', description: 'Develops the key point.' },
        ],
      },
    }),
  );
  writeFileSync(
    join(artifactDir, 'latest-zh-CN.json'),
    JSON.stringify({
      kind: 'insight',
      uiLanguage: 'zh-CN',
      fingerprint: artifactFingerprint,
      filename: `${artifactFingerprint}.json`,
      updatedAt: 1_776_144_000_000,
    }),
  );

  const db = getDb();
  db.prepare(
    `INSERT INTO videos
      (sha256, original_name, ext, size_bytes, duration_s, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'PrivateContractName.mp4', '.mp4', 123, 24, Date.now(), Date.now());
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('generic archive bundle contract', () => {
  it('keeps API ZIP and harness CLI directory aligned on the core bundle contract', async () => {
    const outDir = join(tmpRoot, 'cli-out');
    const cli = spawnSync(process.execPath, [
      scriptPath('export-subcast-bundle.mjs'),
      '--home',
      SUBCAST_PATHS.home,
      '--hash',
      HASH,
      '--recipe',
      'generic-archive-pack',
      '--redact-source-name',
      '--out',
      outDir,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(cli.status, cli.stderr).toBe(0);

    const apiBundle = await buildGenericArchiveBundleZip(HASH);
    const apiZip = await JSZip.loadAsync(apiBundle.buffer);

    expect(Object.keys(apiZip.files).sort()).toEqual([
      'chapters.md',
      'deliverable.md',
      'manifest.json',
      'sources.json',
      'subtitles.srt',
      'summary.md',
      'transcript.md',
    ]);

    const apiManifest = normalizeManifest(await apiZip.files['manifest.json']!.async('string'));
    const cliManifest = normalizeManifest(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect(apiManifest).toMatchObject({
      kind: cliManifest.kind,
      recipe: cliManifest.recipe,
      status: cliManifest.status,
      input: cliManifest.input,
      artifacts: cliManifest.artifacts,
      counts: cliManifest.counts,
    });
    expect(apiManifest.sourceState).toMatchObject({ insightSource: 'artifact' });
    expect(cliManifest.sourceState).toMatchObject({ insightSource: 'artifact' });

    const apiSources = normalizeSources(await apiZip.files['sources.json']!.async('string'));
    const cliSources = normalizeSources(readFileSync(join(outDir, 'sources.json'), 'utf8'));
    expect(apiSources).toMatchObject({
      schemaVersion: cliSources.schemaVersion,
      videoSha: cliSources.videoSha,
      title: cliSources.title,
      sources: cliSources.sources,
      outputReferences: cliSources.outputReferences,
    });

    for (const file of ['transcript.md', 'subtitles.srt', 'chapters.md', 'summary.md', 'deliverable.md']) {
      expect(await apiZip.files[file]!.async('string')).toBe(readFileSync(join(outDir, file), 'utf8'));
    }

    const combinedApiOutput = [
      await apiZip.files['manifest.json']!.async('string'),
      await apiZip.files['sources.json']!.async('string'),
      await apiZip.files['deliverable.md']!.async('string'),
      apiBundle.filename,
    ].join('\n');
    expect(combinedApiOutput).not.toContain('PrivateContractName');
    expect(/\/Users\/|\/tmp\//.test(combinedApiOutput)).toBe(false);
  });
});
