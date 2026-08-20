/* SPDX-License-Identifier: Apache-2.0 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HASH_WITH_INSIGHTS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_WITHOUT_INSIGHTS = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let tmp: string | null = null;

function scriptPath(name: string): string {
  return resolve(process.cwd(), 'scripts', name);
}

function runScript(name: string, args: string[], opts: { expectFailure?: boolean } = {}) {
  const res = spawnSync(process.execPath, [scriptPath(name), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (!opts.expectFailure && res.status !== 0) {
    throw new Error([
      `script failed: ${name}`,
      `status: ${res.status}`,
      `stdout: ${res.stdout}`,
      `stderr: ${res.stderr}`,
    ].join('\n'));
  }
  return res;
}

function runScriptAsync(name: string, args: string[], opts: { expectFailure?: boolean } = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath(name), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (!opts.expectFailure && status !== 0) {
        reject(new Error([
          `script failed: ${name}`,
          `status: ${status}`,
          `stdout: ${stdout}`,
          `stderr: ${stderr}`,
        ].join('\n')));
        return;
      }
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function parseLastJson(output: string) {
  const start = output.indexOf('{');
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(start));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendSse(res: ServerResponse, frames: Array<{ event: string; data: Record<string, unknown> }>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
  for (const frame of frames) {
    res.write(`event: ${frame.event}\n`);
    res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
  }
  res.end();
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function writeCacheItem(home: string, hash: string, withInsights: boolean): void {
  const cacheDir = join(home, 'cache', hash);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, 'original.vtt'),
    [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:04.000',
      'First cue for bundle export.',
      '',
      '00:00:10.000 --> 00:00:13.000',
      'Second cue with enough text for creator review.',
      '',
      '00:00:20.000 --> 00:00:24.000',
      'Final cue closes the sample.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(cacheDir, 'meta.json'),
    JSON.stringify({ ext: 'mp4', model: 'large-v3-turbo', transcribedAt: 1_776_144_000_000 }),
  );
  if (withInsights) {
    writeFileSync(
      join(cacheDir, 'insights.json'),
      JSON.stringify({
        summary: 'Fixture summary.',
        summaryBullets: ['Fixture point one', 'Fixture point two'],
        chapters: [
          { startMs: 1000, title: 'Opening', description: 'Introduces the topic.' },
          { startMs: 10000, title: 'Middle', description: 'Develops the key point.' },
        ],
      }),
    );
  }
}

function writeFixtureDb(home: string): Database.Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(join(home, 'data.sqlite'));
  db.exec(`
    CREATE TABLE videos (
      sha256 TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      display_name TEXT,
      ext TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_s REAL,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      source_url TEXT
    );
    CREATE TABLE transcribe_tasks (
      id TEXT PRIMARY KEY,
      video_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      language TEXT,
      total_chunks INTEGER,
      done_chunks INTEGER NOT NULL DEFAULT 0,
      error_msg TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE insight_tasks (
      id TEXT PRIMARY KEY,
      video_sha TEXT NOT NULL,
      ui_language TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      error_msg TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
  return db;
}

function insertVideo(db: Database.Database, hash: string, ext = '.mp4', sourceUrl: string | null = null): void {
  db.prepare(
    `INSERT INTO videos
      (sha256, original_name, ext, size_bytes, created_at, last_opened_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(hash, 'fixture.mp4', ext, 123, 1_776_144_000_000, 1_776_144_000_000, sourceUrl);
}

function writeVideoFile(home: string, hash: string, ext = '.mp4'): void {
  mkdirSync(join(home, 'videos'), { recursive: true });
  writeFileSync(join(home, 'videos', `${hash}${ext}`), 'fixture video bytes');
}

function makeHome(): string {
  tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
  const home = join(tmp, 'home');
  writeCacheItem(home, HASH_WITH_INSIGHTS, true);
  writeCacheItem(home, HASH_WITHOUT_INSIGHTS, false);
  return home;
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function containsRawPath(text: string): boolean {
  return /\/Users\/|\/tmp\//.test(text);
}

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('Subcast harness CLI scripts', () => {
  it('lists candidates without leaking paths or transcript text', () => {
    const home = makeHome();
    const res = runScript('list-subcast-bundle-candidates.mjs', [
      '--home',
      home,
      '--with-insights',
    ]);
    const json = parseLastJson(res.stdout);

    expect(json.ok).toBe(true);
    expect(json.count).toBe(1);
    expect(json.candidates[0]).toMatchObject({
      hashPrefix: HASH_WITH_INSIGHTS.slice(0, 12),
      cueCount: 3,
      hasInsights: true,
      cacheOnly: true,
    });
    expect(res.stdout).not.toContain('First cue');
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('exports and scores an insights-backed creator bundle with persisted score', () => {
    const home = makeHome();
    const outDir = join(tmp!, 'out');
    const exportRes = runScript('export-subcast-bundle.mjs', [
      '--home',
      home,
      '--hash',
      HASH_WITH_INSIGHTS.slice(0, 12),
      '--recipe',
      'creator-brief',
      '--require-insights',
      '--out',
      outDir,
    ]);
    const exportJson = parseLastJson(exportRes.stdout);
    expect(exportJson).toMatchObject({
      ok: true,
      recipe: 'creator-brief',
      cues: 3,
      chapters: 2,
      insightSource: 'legacy',
    });

    const rubricPath = join(tmp!, 'creator-rubric.json');
    writeFileSync(
      rubricPath,
      JSON.stringify({
        schemaVersion: 1,
        passScore: 80,
        weights: {
          artifactCompleteness: 15,
          citationCoverage: 25,
          groundedness: 20,
          taskUsefulness: 20,
          structureStability: 5,
          latency: 10,
          privacy: 5,
        },
        blockers: [
          'missing_manifest',
          'missing_sources',
          'no_timestamped_clip_candidates',
          'creator_brief_without_cached_insights',
          'invalid_srt',
          'raw_local_path_in_log_or_manifest',
          'raw_transcript_in_log',
        ],
      }),
    );
    const scorePath = join(outDir, 'score.json');
    const scoreRes = runScript('score-subcast-bundle.mjs', [
      '--bundle',
      outDir,
      '--rubric',
      rubricPath,
      '--out',
      scorePath,
    ]);
    const scoreJson = parseLastJson(scoreRes.stdout);
    const persisted = JSON.parse(readFileSync(scorePath, 'utf8'));

    expect(scoreJson.ok).toBe(true);
    expect(persisted).toMatchObject({
      ok: true,
      blockers: [],
      evidence: {
        sourceCount: 3,
        outputReferenceCount: 2,
        recipe: 'creator-brief',
        insightSource: 'legacy',
      },
    });
    for (const file of [
      'manifest.json',
      'transcript.md',
      'subtitles.srt',
      'chapters.md',
      'summary.md',
      'sources.json',
      'deliverable.md',
      'score.json',
    ]) {
      expect(existsSync(join(outDir, file))).toBe(true);
    }
    expect(containsRawPath(readFileSync(join(outDir, 'manifest.json'), 'utf8'))).toBe(false);
    expect(containsRawPath(readFileSync(scorePath, 'utf8'))).toBe(false);
  });

  it('fails creator export when cached insights are required but missing', () => {
    const home = makeHome();
    const res = runScript('export-subcast-bundle.mjs', [
      '--home',
      home,
      '--hash',
      HASH_WITHOUT_INSIGHTS.slice(0, 12),
      '--recipe',
      'creator-brief',
      '--require-insights',
      '--out',
      join(tmp!, 'missing-insights-out'),
    ], { expectFailure: true });
    const json = parseLastJson(res.stderr);

    expect(res.status).toBe(1);
    expect(json).toMatchObject({
      ok: false,
      code: 'INSIGHTS_REQUIRED',
    });
    expect(containsRawPath(res.stderr)).toBe(false);
  });

  it('exports and scores an insights-backed meeting notes bundle', () => {
    const home = makeHome();
    const outDir = join(tmp!, 'meeting-out');
    const exportRes = runScript('export-subcast-bundle.mjs', [
      '--home',
      home,
      '--hash',
      HASH_WITH_INSIGHTS.slice(0, 12),
      '--recipe',
      'meeting-notes',
      '--require-insights',
      '--out',
      outDir,
    ]);
    const exportJson = parseLastJson(exportRes.stdout);
    expect(exportJson).toMatchObject({
      ok: true,
      recipe: 'meeting-notes',
      cues: 3,
      chapters: 2,
      insightSource: 'legacy',
    });
    const deliverable = readFileSync(join(outDir, 'deliverable.md'), 'utf8');
    expect(deliverable).toContain('## Action Items');
    expect(deliverable).toContain('Not inferred by this adapter');
    expect(deliverable).toContain('cue-00001');

    const rubricPath = join(tmp!, 'meeting-rubric.json');
    writeFileSync(
      rubricPath,
      JSON.stringify({
        schemaVersion: 1,
        passScore: 80,
        weights: {
          artifactCompleteness: 15,
          citationCoverage: 25,
          groundedness: 25,
          taskUsefulness: 15,
          structureStability: 10,
          latency: 5,
          privacy: 5,
        },
        blockers: [
          'missing_manifest',
          'missing_sources',
          'no_timestamped_citations',
          'meeting_notes_without_cached_insights',
          'invalid_srt',
          'raw_local_path_in_log_or_manifest',
          'raw_transcript_in_log',
        ],
      }),
    );
    const scorePath = join(outDir, 'score.json');
    const scoreRes = runScript('score-subcast-bundle.mjs', [
      '--bundle',
      outDir,
      '--rubric',
      rubricPath,
      '--out',
      scorePath,
    ]);
    const scoreJson = parseLastJson(scoreRes.stdout);

    expect(scoreJson).toMatchObject({
      ok: true,
      blockers: [],
      evidence: {
        sourceCount: 3,
        outputReferenceCount: 2,
        recipe: 'meeting-notes',
        insightSource: 'legacy',
      },
    });
    expect(existsSync(scorePath)).toBe(true);
    expect(containsRawPath(readFileSync(join(outDir, 'manifest.json'), 'utf8'))).toBe(false);
    expect(containsRawPath(readFileSync(scorePath, 'utf8'))).toBe(false);
  });

  it('runs the full existing-cache harness loop and auto-selects an insights candidate', () => {
    const home = makeHome();
    const outDir = join(tmp!, 'run-out');
    const res = runScript('run-subcast-harness.mjs', [
      '--home',
      home,
      '--recipe',
      'meeting-notes',
      '--out',
      outDir,
    ]);
    const json = parseLastJson(res.stdout);

    expect(json).toMatchObject({
      ok: true,
      recipe: 'meeting-notes',
      selectedHash: HASH_WITH_INSIGHTS.slice(0, 12),
      cues: 3,
      chapters: 2,
      insightSource: 'legacy',
      blockers: [],
    });
    expect(typeof json.score).toBe('number');
    expect(existsSync(join(outDir, 'score.json'))).toBe(true);
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('runs the harness from an already-transcribed local input file', () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const inputBody = 'local media bytes used for cache lookup';
    const inputHash = sha256Text(inputBody);
    const inputFile = join(tmp, 'fixture.mp4');
    const outDir = join(tmp, 'input-run-out');
    writeFileSync(inputFile, inputBody);
    writeCacheItem(home, inputHash, false);

    const res = runScript('run-subcast-harness.mjs', [
      '--home',
      home,
      '--recipe',
      'generic-archive-pack',
      '--input',
      inputFile,
      '--out',
      outDir,
    ]);
    const json = parseLastJson(res.stdout);

    expect(json).toMatchObject({
      ok: true,
      recipe: 'generic-archive-pack',
      selectedHash: inputHash.slice(0, 12),
      cues: 3,
      blockers: [],
    });
    expect(existsSync(join(outDir, 'score.json'))).toBe(true);
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('fails local input lookup when the file has not been transcribed without leaking paths', () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const inputFile = join(tmp, 'untranscribed.mov');
    writeFileSync(inputFile, 'media bytes without cache');

    const res = runScript('run-subcast-harness.mjs', [
      '--home',
      home,
      '--recipe',
      'generic-archive-pack',
      '--input',
      inputFile,
      '--out',
      join(tmp, 'input-missing-out'),
    ], { expectFailure: true });
    const json = parseLastJson(res.stderr);

    expect(res.status).toBe(1);
    expect(json).toMatchObject({
      ok: false,
      code: 'INPUT_NOT_TRANSCRIBED',
    });
    expect(containsRawPath(res.stderr)).toBe(false);
  });

  it('rejects non-file local input without leaking paths', () => {
    const home = makeHome();
    const inputDir = join(tmp!, 'input-dir');
    mkdirSync(inputDir);

    const res = runScript('run-subcast-harness.mjs', [
      '--home',
      home,
      '--recipe',
      'generic-archive-pack',
      '--input',
      inputDir,
      '--out',
      join(tmp!, 'input-dir-out'),
    ], { expectFailure: true });
    const json = parseLastJson(res.stderr);

    expect(res.status).toBe(1);
    expect(json).toMatchObject({
      ok: false,
      code: 'INPUT_NOT_FILE',
    });
    expect(containsRawPath(res.stderr)).toBe(false);
  });

  it('preflights a ready local input for bundle export without leaking paths', () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const db = writeFixtureDb(home);
    const inputBody = 'ready local media bytes';
    const hash = sha256Text(inputBody);
    const inputFile = join(tmp, 'ready.mp4');
    writeFileSync(inputFile, inputBody);
    insertVideo(db, hash);
    db.close();
    writeVideoFile(home, hash);
    writeCacheItem(home, hash, true);

    const res = runScript('preflight-subcast-media-run.mjs', [
      '--home',
      home,
      '--recipe',
      'creator-brief',
      '--input',
      inputFile,
    ]);
    const json = parseLastJson(res.stdout);

    expect(json).toMatchObject({
      ok: true,
      recipe: 'creator-brief',
      inputKind: 'file',
      phase: 'bundle_ready',
      hashPrefix: hash.slice(0, 12),
      hasVideoRow: true,
      hasMediaFile: true,
      hasTranscript: true,
      hasInsights: true,
      missingSteps: [],
      nextAction: 'export_bundle',
    });
    expect(json.nextCommand).toContain(`--hash ${hash.slice(0, 12)}`);
    expect(json.hash).toBeUndefined();
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('preflights an imported local input that still needs transcription', () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const db = writeFixtureDb(home);
    const inputBody = 'imported media without transcript';
    const hash = sha256Text(inputBody);
    const inputFile = join(tmp, 'needs-transcribe.mp4');
    writeFileSync(inputFile, inputBody);
    insertVideo(db, hash);
    db.close();
    writeVideoFile(home, hash);

    const res = runScript('preflight-subcast-media-run.mjs', [
      '--home',
      home,
      '--recipe',
      'generic-archive-pack',
      '--input',
      inputFile,
    ]);
    const json = parseLastJson(res.stdout);

    expect(json).toMatchObject({
      ok: true,
      inputKind: 'file',
      phase: 'transcribe_needed',
      hashPrefix: hash.slice(0, 12),
      hasTranscript: false,
      missingSteps: ['transcribe'],
      nextAction: 'start_transcribe',
    });
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('preflights a transcribed creator input that still needs insights', () => {
    const home = makeHome();
    const db = writeFixtureDb(home);
    insertVideo(db, HASH_WITHOUT_INSIGHTS);
    db.close();
    writeVideoFile(home, HASH_WITHOUT_INSIGHTS);

    const inputFile = join(tmp!, 'creator.mp4');
    copyFileSync(join(home, 'videos', `${HASH_WITHOUT_INSIGHTS}.mp4`), inputFile);
    const actualHash = sha256Text('fixture video bytes');
    writeCacheItem(home, actualHash, false);
    const db2 = new Database(join(home, 'data.sqlite'));
    insertVideo(db2, actualHash);
    db2.close();
    writeVideoFile(home, actualHash);

    const res = runScript('preflight-subcast-media-run.mjs', [
      '--home',
      home,
      '--recipe',
      'creator-brief',
      '--input',
      inputFile,
    ]);
    const json = parseLastJson(res.stdout);

    expect(json).toMatchObject({
      ok: true,
      inputKind: 'file',
      phase: 'insights_needed',
      hashPrefix: actualHash.slice(0, 12),
      hasTranscript: true,
      hasInsights: false,
      missingSteps: ['insights'],
      nextAction: 'start_insights',
    });
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('preflights a new URL as needing URL import without echoing the URL', () => {
    const home = makeHome();
    const db = writeFixtureDb(home);
    db.close();

    const res = runScript('preflight-subcast-media-run.mjs', [
      '--home',
      home,
      '--recipe',
      'generic-archive-pack',
      '--url',
      'https://example.com/private/video.mp4?token=secret',
    ]);
    const json = parseLastJson(res.stdout);

    expect(json).toMatchObject({
      ok: true,
      inputKind: 'url',
      phase: 'url_import_needed',
      missingSteps: ['import'],
      nextAction: 'import_url',
    });
    expect(res.stdout).not.toContain('example.com');
    expect(res.stdout).not.toContain('secret');
    expect(containsRawPath(res.stdout)).toBe(false);
  });

  it('runs the app-backed flow from local import through transcription to bundle export', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const db = writeFixtureDb(home);
    db.close();
    const inputBody = 'new app flow media bytes';
    const hash = sha256Text(inputBody);
    const inputFile = join(tmp, 'app-flow.mp4');
    const outDir = join(tmp, 'app-flow-out');
    const apiToken = 'test-local-flow-token';
    writeFileSync(inputFile, inputBody);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.headers['x-subcast-token'] !== apiToken) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/desktop/upload-from-path') {
        await readJsonBody(req);
        const db2 = new Database(join(home, 'data.sqlite'));
        insertVideo(db2, hash);
        db2.close();
        writeVideoFile(home, hash);
        sendJson(res, { hash });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/transcribe') {
        if (url.searchParams.get('hash') !== hash) {
          res.writeHead(400);
          res.end();
          return;
        }
        writeCacheItem(home, hash, false);
        sendSse(res, [
          { event: 'status', data: { status: 'running' } },
          { event: 'done', data: { totalCues: 3 } },
        ]);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);
    try {
      const res = await runScriptAsync('run-subcast-app-flow.mjs', [
        '--home',
        home,
        '--base-url',
        baseUrl,
        '--api-token',
        apiToken,
        '--recipe',
        'generic-archive-pack',
        '--input',
        inputFile,
        '--out',
        outDir,
        '--timeout-ms',
        '5000',
      ]);
      const json = parseLastJson(res.stdout);

      expect(json).toMatchObject({
        ok: true,
        recipe: 'generic-archive-pack',
        phase: 'bundle_exported',
        hashPrefix: hash.slice(0, 12),
        appPhases: ['import_needed', 'transcribe_needed', 'bundle_ready'],
        blockers: [],
      });
      expect(existsSync(join(outDir, 'score.json'))).toBe(true);
      expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).not.toContain('fixture.mp4');
      expect(readFileSync(join(outDir, 'deliverable.md'), 'utf8')).not.toContain('fixture.mp4');
      expect(res.stdout).not.toContain('app-flow.mp4');
      expect(res.stdout).not.toContain(apiToken);
      expect(containsRawPath(res.stdout)).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('runs the app-backed flow from private URL through import, transcription, insights, and bundle export', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const db = writeFixtureDb(home);
    db.close();
    const urlInput = 'https://example.com/private/video.mp4?token=secret';
    const hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const outDir = join(tmp, 'url-app-flow-out');
    const apiToken = 'test-url-flow-token';

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.headers['x-subcast-token'] !== apiToken) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/import-url') {
        await readJsonBody(req);
        sendJson(res, { jobId: 'job-url-flow' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/import-url') {
        const db2 = new Database(join(home, 'data.sqlite'));
        insertVideo(db2, hash, '.mp4', urlInput);
        db2.close();
        writeVideoFile(home, hash);
        sendSse(res, [
          { event: 'progress', data: { phase: 'downloading', percent: 1 } },
          { event: 'progress', data: { phase: 'done', hash } },
        ]);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/transcribe') {
        if (url.searchParams.get('hash') !== hash) {
          res.writeHead(400);
          res.end();
          return;
        }
        writeCacheItem(home, hash, false);
        sendSse(res, [
          { event: 'status', data: { status: 'running' } },
          { event: 'done', data: { totalCues: 3 } },
        ]);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/insights') {
        if (url.searchParams.get('hash') !== hash) {
          res.writeHead(400);
          res.end();
          return;
        }
        writeCacheItem(home, hash, true);
        sendSse(res, [
          { event: 'start', data: { taskId: 'insight-task' } },
          { event: 'done', data: { fromCache: false } },
        ]);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);
    try {
      const res = await runScriptAsync('run-subcast-app-flow.mjs', [
        '--home',
        home,
        '--base-url',
        baseUrl,
        '--api-token',
        apiToken,
        '--recipe',
        'creator-brief',
        '--url',
        urlInput,
        '--out',
        outDir,
        '--timeout-ms',
        '5000',
      ]);
      const json = parseLastJson(res.stdout);

      expect(json).toMatchObject({
        ok: true,
        recipe: 'creator-brief',
        phase: 'bundle_exported',
        hashPrefix: hash.slice(0, 12),
        appPhases: ['url_import_needed', 'transcribe_needed', 'insights_needed', 'bundle_ready'],
        blockers: [],
      });
      expect(existsSync(join(outDir, 'score.json'))).toBe(true);
      expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).not.toContain('fixture.mp4');
      expect(readFileSync(join(outDir, 'deliverable.md'), 'utf8')).not.toContain('fixture.mp4');
      expect(res.stdout).not.toContain('example.com');
      expect(res.stdout).not.toContain('secret');
      expect(res.stdout).not.toContain(apiToken);
      expect(containsRawPath(res.stdout)).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('reports a stage-specific app-flow failure when transcription cannot start', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const db = writeFixtureDb(home);
    db.close();
    const inputBody = 'media bytes for unavailable model';
    const hash = sha256Text(inputBody);
    const inputFile = join(tmp, 'model-missing.mp4');
    writeFileSync(inputFile, inputBody);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/desktop/upload-from-path') {
        await readJsonBody(req);
        const db2 = new Database(join(home, 'data.sqlite'));
        insertVideo(db2, hash);
        db2.close();
        writeVideoFile(home, hash);
        sendJson(res, { hash });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/transcribe') {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ statusMessage: 'WHISPER_MODEL_NOT_INSTALLED' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);
    try {
      const res = await runScriptAsync('run-subcast-app-flow.mjs', [
        '--home',
        home,
        '--base-url',
        baseUrl,
        '--recipe',
        'generic-archive-pack',
        '--input',
        inputFile,
        '--out',
        join(tmp, 'model-missing-out'),
        '--timeout-ms',
        '5000',
      ], { expectFailure: true });
      const json = parseLastJson(res.stderr);

      expect(res.status).toBe(1);
      expect(json).toMatchObject({
        ok: false,
        code: 'APP_TRANSCRIBE_START_FAILED',
        appPhases: ['import_needed', 'transcribe_needed'],
        httpStatus: 409,
      });
      expect(res.stderr).not.toContain('model-missing.mp4');
      expect(containsRawPath(res.stderr)).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('reports a stage-specific app-flow failure when local file import fails', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'subcast-harness-cli-'));
    const home = join(tmp, 'home');
    const db = writeFixtureDb(home);
    db.close();
    const inputFile = join(tmp, 'import-fails.wav');
    writeFileSync(inputFile, 'media bytes');

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/api/desktop/upload-from-path') {
        await readJsonBody(req);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'internal path /tmp/secret' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const baseUrl = await listen(server);
    try {
      const res = await runScriptAsync('run-subcast-app-flow.mjs', [
        '--home',
        home,
        '--base-url',
        baseUrl,
        '--recipe',
        'generic-archive-pack',
        '--input',
        inputFile,
        '--out',
        join(tmp, 'import-fails-out'),
        '--timeout-ms',
        '5000',
      ], { expectFailure: true });
      const json = parseLastJson(res.stderr);

      expect(res.status).toBe(1);
      expect(json).toMatchObject({
        ok: false,
        code: 'APP_IMPORT_FILE_FAILED',
        appPhases: ['import_needed'],
        httpStatus: 500,
      });
      expect(res.stderr).not.toContain('import-fails.wav');
      expect(res.stderr).not.toContain('secret');
      expect(containsRawPath(res.stderr)).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('rejects ambiguous hash and input arguments', () => {
    const home = makeHome();
    const inputFile = join(tmp!, 'fixture.mp4');
    writeFileSync(inputFile, 'media bytes');

    const res = runScript('run-subcast-harness.mjs', [
      '--home',
      home,
      '--recipe',
      'generic-archive-pack',
      '--hash',
      HASH_WITH_INSIGHTS.slice(0, 12),
      '--input',
      inputFile,
      '--out',
      join(tmp!, 'ambiguous-out'),
    ], { expectFailure: true });
    const json = parseLastJson(res.stderr);

    expect(res.status).toBe(1);
    expect(json).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_INPUT',
    });
    expect(containsRawPath(res.stderr)).toBe(false);
  });
});
