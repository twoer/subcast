/* SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const root = mkdtempSync(join(tmpdir(), 'subcast-agent-api-'));
  process.env.SUBCAST_HOME = join(root, 'home');
  process.env.SUBCAST_DESKTOP = 'true';
  return { tmpRoot: root };
});

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>();
  return {
    ...actual,
    readBody: async (event: { _body?: unknown }) => event._body,
  };
});

vi.mock('../videoDuration', () => ({
  backfillVideoDurationS: vi.fn(),
}));

/* eslint-disable import/first -- env and h3 mocks must be installed before route imports */
import { closeDb, getDb, SUBCAST_PATHS } from '../db';
import importHandler from '../../api/agent/import.post';
import exportHandler from '../../api/agent/export.post';
import mediaHandler from '../../api/agent/media/[hash].get';
/* eslint-enable import/first */

const HASH = 'a'.repeat(64);

function eventWithBody(body: unknown) {
  const headers = new Map<string, string | number | readonly string[]>();
  return {
    node: {
      req: { method: 'POST', headers: {} },
      res: {
        setHeader: (name: string, value: string | number | readonly string[]) => headers.set(name, value),
        getHeader: (name: string) => headers.get(name),
        getHeaderNames: () => Array.from(headers.keys()),
        hasHeader: (name: string) => headers.has(name),
      },
    },
    context: {},
    _body: body,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function eventWithHash(hash: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `/api/agent/media/${hash}${qs ? `?${qs}` : ''}`;
  return {
    path: url,
    node: { req: { method: 'GET', headers: {}, url }, res: {} },
    context: { params: { hash } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function resetHome(): void {
  closeDb();
  rmSync(SUBCAST_PATHS.home, { recursive: true, force: true });
  mkdirSync(SUBCAST_PATHS.home, { recursive: true });
  getDb();
}

function insertVideo(hash = HASH): void {
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO videos (sha256, original_name, ext, size_bytes, created_at, last_opened_at)
     VALUES (?, ?, '.mp4', 123, ?, ?)`,
  ).run(hash, 'private-source-name.mp4', now, now);
  mkdirSync(SUBCAST_PATHS.videos, { recursive: true });
  writeFileSync(join(SUBCAST_PATHS.videos, `${hash}.mp4`), 'video bytes');
}

function writeTranscript(hash = HASH): void {
  const cacheDir = join(SUBCAST_PATHS.cache, hash);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, 'original.vtt'),
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'hello',
      '',
    ].join('\n'),
  );
}

function writeInsightArtifact(hash = HASH, lang = 'en'): void {
  const artifactDir = join(SUBCAST_PATHS.cache, hash, 'artifacts', 'insight');
  mkdirSync(artifactDir, { recursive: true });
  const fingerprint = 'f'.repeat(64);
  writeFileSync(
    join(artifactDir, `${fingerprint}.json`),
    JSON.stringify({
      kind: 'insight',
      videoSha: hash,
      uiLanguage: lang,
      fingerprint,
      payload: {
        summary: 'ok',
        summaryBullets: ['Approve the launch plan after review.'],
        chapters: [{ startMs: 0, title: 'Opening', description: 'Sets the launch context.' }],
      },
    }),
  );
  writeFileSync(
    join(artifactDir, `latest-${lang}.json`),
    JSON.stringify({
      kind: 'insight',
      uiLanguage: lang,
      fingerprint,
      filename: `${fingerprint}.json`,
      updatedAt: Date.now(),
    }),
  );
}

beforeEach(resetHome);

describe('agent control API', () => {
  it('imports a local media path without leaking the original path or filename', async () => {
    const sourceDir = join(tmpRoot, 'private-inputs');
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, 'secret-board-meeting.mp4');
    writeFileSync(sourcePath, 'fixture video bytes');

    const res = await importHandler(eventWithBody({
      path: sourcePath,
      recipe: 'creator-brief',
      language: 'en',
    }));

    expect(res).toMatchObject({
      ok: true,
      imported: true,
      hashPrefix: expect.stringMatching(/^[0-9a-f]{12}$/),
      media: expect.objectContaining({
        recipe: 'creator-brief',
        language: 'en',
        sourceNameRedacted: true,
        phase: 'transcribe_needed',
        nextAction: 'start_transcribe',
      }),
    });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(sourcePath);
    expect(serialized).not.toContain('secret-board-meeting');
  });

  it('reports media readiness phases for transcript and Insights', async () => {
    insertVideo();

    expect(await mediaHandler(eventWithHash(HASH, { recipe: 'creator-brief', language: 'en' })))
      .toMatchObject({
        phase: 'transcribe_needed',
        nextAction: 'start_transcribe',
        hasTranscript: false,
        missingSteps: ['transcript'],
      });

    getDb().prepare(
      `INSERT INTO transcribe_tasks (id, video_sha, status, model, created_at)
       VALUES ('t1', ?, 'queued', 'base', ?)`,
    ).run(HASH, Date.now());
    expect(await mediaHandler(eventWithHash(HASH, { recipe: 'creator-brief', language: 'en' })))
      .toMatchObject({
        phase: 'transcribe_pending',
        nextAction: 'wait_for_transcribe',
        transcribeStatus: 'queued',
      });

    writeTranscript();
    expect(await mediaHandler(eventWithHash(HASH, { recipe: 'creator-brief', language: 'en' })))
      .toMatchObject({
        phase: 'insights_needed',
        nextAction: 'start_insights',
        hasTranscript: true,
        hasInsights: false,
        missingSteps: ['insights'],
      });

    writeInsightArtifact();
    expect(await mediaHandler(eventWithHash(HASH, { recipe: 'creator-brief', language: 'en' })))
      .toMatchObject({
        phase: 'bundle_ready',
        nextAction: 'export_bundle',
        hasInsights: true,
        missingSteps: [],
      });
  });

  it('exports a redacted generic media pack only after the transcript is ready', async () => {
    insertVideo();
    await expect(exportHandler(eventWithBody({ hash: HASH }))).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: 'MEDIA_NOT_READY',
    });

    writeTranscript();
    const ready = eventWithBody({ hash: HASH, language: 'en' });
    const body = await exportHandler(ready);
    expect(body).toBeInstanceOf(Buffer);
    expect(ready.node.res.getHeader('Content-Type')).toBe('application/zip');
    expect(ready.node.res.getHeader('Content-Disposition')).toBe(`attachment; filename="subcast-${HASH.slice(0, 12)}.skill-bundle.zip"`);
  });

  it('exports creator and meeting packs only after matching-language Insights are ready', async () => {
    insertVideo();
    writeTranscript();

    await expect(exportHandler(eventWithBody({ hash: HASH, recipe: 'creator-brief', language: 'en' }))).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: 'MEDIA_NOT_READY',
    });

    writeInsightArtifact(HASH, 'en');
    for (const [recipe, heading] of [
      ['creator-brief', 'Creator Editing Brief'],
      ['meeting-notes', 'Meeting Notes Evidence Pack'],
    ] as const) {
      const result = await exportHandler(eventWithBody({ hash: HASH, recipe, language: 'en' }));
      const zip = await JSZip.loadAsync(result as Buffer);
      const manifest = JSON.parse(await zip.files['manifest.json']!.async('string')) as { recipe: string };
      const deliverable = await zip.files['deliverable.md']!.async('string');
      const sources = await zip.files['sources.json']!.async('string');

      expect(manifest.recipe).toBe(recipe);
      expect(deliverable).toContain(heading);
      expect(sources).toContain('deliverable.md');
      expect(`${deliverable}\n${sources}`).not.toContain('private-source-name');
      expect(`${deliverable}\n${sources}`).not.toMatch(/\/Users\/|\/tmp\//);
    }
  });
});
