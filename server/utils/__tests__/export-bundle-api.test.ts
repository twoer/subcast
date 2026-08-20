/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import JSZip from 'jszip';

const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const r = mkdtempSync(join(tmpdir(), 'subcast-export-bundle-'));
  process.env.SUBCAST_HOME = r;
  return { tmpRoot: r };
});

/* eslint-disable import/first -- imports must follow vi.hoisted() so SUBCAST_HOME is set first */
import { join } from 'node:path';
import handler from '../../api/export-bundle.get';
import { closeDb, getDb, SUBCAST_PATHS } from '../db';
/* eslint-enable import/first */

const HASH = 'c'.repeat(64);

function makeEvent(query: Record<string, string>) {
  const url = '/api/export-bundle?' + new URLSearchParams(query).toString();
  const headers = new Map<string, string | number | string[]>();
  return {
    event: {
      path: url,
      node: {
        req: { url, method: 'GET', headers: {} },
        res: {
          setHeader: (name: string, value: string | number | readonly string[]) => {
            headers.set(name, Array.isArray(value) ? value : value);
          },
          getHeader: (name: string) => headers.get(name),
          getHeaderNames: () => Array.from(headers.keys()),
          hasHeader: (name: string) => headers.has(name),
          end: () => {},
          write: () => true,
        },
      },
      context: {},
      _handled: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal h3 event stub for unit-level handler invocation
    } as any,
    headers,
  };
}

beforeAll(() => {
  mkdirSync(join(SUBCAST_PATHS.cache, HASH), { recursive: true });
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'original.vtt'),
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'Hello from the private source name',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Second cue',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(SUBCAST_PATHS.cache, HASH, 'insights.json'),
    JSON.stringify({
      summary: 'Short cached summary.',
      summaryBullets: ['First point'],
      chapters: [{ startMs: 0, title: 'Opening', description: 'Starts the recording' }],
    }),
  );

  const db = getDb();
  db.prepare(
    `INSERT INTO videos (sha256, original_name, display_name, ext, size_bytes, duration_s, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(HASH, 'PrivateMeeting.mov', null, '.mov', 1234, 2, Date.now(), Date.now());
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('/api/export-bundle', () => {
  it('returns a redacted generic archive bundle ZIP', async () => {
    const { event, headers } = makeEvent({ hash: HASH });
    const body = await handler(event);
    expect(body).toBeInstanceOf(Buffer);
    expect(headers.get('Content-Type')).toBe('application/zip');
    expect(headers.get('Content-Disposition')).toBe(`attachment; filename="subcast-${HASH.slice(0, 12)}.skill-bundle.zip"`);

    const zip = await JSZip.loadAsync(body as Buffer);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      'chapters.md',
      'deliverable.md',
      'manifest.json',
      'sources.json',
      'subtitles.srt',
      'summary.md',
      'transcript.md',
    ]);

    const manifest = JSON.parse(await zip.files['manifest.json']!.async('string')) as {
      recipe: string;
      input: { title: string; sourceNameRedacted: boolean };
      counts: { cues: number; chapters: number };
    };
    expect(manifest).toMatchObject({
      recipe: 'generic-archive-pack',
      input: {
        title: `subcast-${HASH.slice(0, 12)}`,
        sourceNameRedacted: true,
      },
      counts: { cues: 2, chapters: 1 },
    });

    const deliverable = await zip.files['deliverable.md']!.async('string');
    expect(deliverable).toContain('Local Archive Pack');
    expect(deliverable).not.toContain('PrivateMeeting');
  });

  it('rejects unsupported recipes for the product API slice', async () => {
    const { event } = makeEvent({ hash: HASH, recipe: 'creator-brief' });
    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'UNSUPPORTED_RECIPE',
    });
  });
});
