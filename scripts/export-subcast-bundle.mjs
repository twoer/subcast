#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const RECIPES = new Set(['generic-archive-pack', 'creator-brief', 'meeting-notes']);
const HASH_RE = /^[a-f0-9]{12,128}$/i;

function usage() {
  return [
    'Usage:',
    '  node scripts/export-subcast-bundle.mjs --hash <video-sha> --out <dir> [--recipe generic-archive-pack|creator-brief|meeting-notes] [--home <subcast-home>] [--lang zh-CN|en] [--require-insights] [--redact-source-name]',
    '',
    'Exports an existing Subcast cache item into a timestamped artifact bundle.',
    'This adapter reads SQLite/cache state only; it does not transcribe, translate, or call an LLM.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    recipe: 'generic-archive-pack',
    lang: 'zh-CN',
    home: process.env.SUBCAST_HOME ?? join(homedir(), '.subcast'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--require-insights') {
      args.requireInsights = true;
      continue;
    }
    if (arg === '--redact-source-name') {
      args.redactSourceName = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'hash') args.hash = value;
    else if (key === 'out') args.out = value;
    else if (key === 'recipe') args.recipe = value;
    else if (key === 'home') args.home = value;
    else if (key === 'lang') args.lang = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

function fail(code, message, details = {}) {
  const payload = { ok: false, code, message, ...details };
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function msToClock(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function msToSrtTs(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const k = ms % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(k).padStart(3, '0')}`;
}

const VTT_TS =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

function tsToMs(h, m, s, ms) {
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1_000 + Number(ms);
}

function parseVtt(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i]?.match(VTT_TS);
    if (!match) {
      i++;
      continue;
    }
    const startMs = tsToMs(match[1], match[2], match[3], match[4]);
    const endMs = tsToMs(match[5], match[6], match[7], match[8]);
    i++;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }
    if (textLines.length > 0) cues.push({ startMs, endMs, text: textLines.join('\n') });
  }
  return cues;
}

function serializeSrt(cues) {
  if (cues.length === 0) return '';
  const parts = [];
  cues.forEach((cue, i) => {
    parts.push(String(i + 1));
    parts.push(`${msToSrtTs(cue.startMs)} --> ${msToSrtTs(cue.endMs)}`);
    parts.push(cue.text);
    parts.push('');
  });
  return `${parts.join('\n')}\n`;
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function snippetHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function loadVideo(db, hash) {
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT sha256, original_name, display_name, ext, size_bytes, duration_s, created_at, last_opened_at
         FROM videos
         WHERE sha256 LIKE ? AND COALESCE(deleted_at, 0) = 0
         ORDER BY last_opened_at DESC
         LIMIT 2`,
      )
      .all(`${hash}%`);
  } catch {
    rows = db
      .prepare(
        `SELECT sha256, original_name, display_name, ext, size_bytes, duration_s, created_at, last_opened_at
         FROM videos
         WHERE sha256 LIKE ?
         ORDER BY last_opened_at DESC
         LIMIT 2`,
      )
      .all(`${hash}%`);
  }
  if (rows.length > 1) {
    throw new Error('AMBIGUOUS_HASH');
  }
  return rows[0] ?? null;
}

function resolveCacheHash(home, hash) {
  const cacheRoot = join(home, 'cache');
  if (!existsSync(cacheRoot)) return null;
  const matches = readdirSync(cacheRoot)
    .filter((name) => HASH_RE.test(name))
    .filter((name) => name.toLowerCase().startsWith(hash.toLowerCase()))
    .filter((name) => existsSync(join(cacheRoot, name, 'original.vtt')));
  if (matches.length > 1) throw new Error('AMBIGUOUS_HASH');
  return matches[0] ?? null;
}

function cacheOnlyVideo(home, hash) {
  const resolvedHash = resolveCacheHash(home, hash);
  if (!resolvedHash) return null;
  const meta = readJson(join(home, 'cache', resolvedHash, 'meta.json')) ?? {};
  return {
    sha256: resolvedHash,
    original_name: `subcast-${resolvedHash.slice(0, 12)}`,
    display_name: null,
    ext: typeof meta.ext === 'string' ? meta.ext : '',
    size_bytes: null,
    duration_s: null,
    created_at: typeof meta.transcribedAt === 'number' ? meta.transcribedAt : null,
    last_opened_at: typeof meta.transcribedAt === 'number' ? meta.transcribedAt : null,
    cacheOnly: true,
  };
}

function loadLatestTranscribeTask(db, hash) {
  return db
    .prepare(
      `SELECT id, status, model, language, total_chunks, done_chunks, error_code, created_at, completed_at
       FROM transcribe_tasks
       WHERE video_sha = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(hash);
}

function loadDiarizeTask(db, hash) {
  try {
    return db
      .prepare(
        `SELECT status, final_speaker_count, unknown_ratio, top_k, error_code, completed_at
         FROM diarize_tasks
         WHERE video_sha = ?`,
      )
      .get(hash);
  } catch {
    return null;
  }
}

function loadInsightTask(db, hash, lang) {
  try {
    return db
      .prepare(
        `SELECT id, status, model, ui_language, error_code, invocation_fingerprint, created_at, completed_at
         FROM insight_tasks
         WHERE video_sha = ? AND ui_language = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(hash, lang);
  } catch {
    return null;
  }
}

function loadLatestInsight(cacheDir, lang) {
  const artifactDir = join(cacheDir, 'artifacts', 'insight');
  const pointerPath = join(artifactDir, `latest-${lang}.json`);
  const legacyPath = join(cacheDir, 'insights.json');
  const pointer = readJson(pointerPath);
  if (pointer?.filename) {
    const artifact = readJson(join(artifactDir, basename(pointer.filename)));
    if (
      artifact?.kind === 'insight'
      && artifact.fingerprint === pointer.fingerprint
      && artifact.uiLanguage === lang
      && artifact.payload
    ) {
      return { payload: artifact.payload, source: 'artifact', generatedAt: artifact.generatedAt };
    }
  }
  const legacy = readJson(legacyPath);
  if (legacy) return { payload: legacy, source: 'legacy', generatedAt: null };
  return null;
}

function transcriptMarkdown(cues, title) {
  const out = [`# Transcript`, '', `Source: ${title}`, ''];
  for (const cue of cues) {
    out.push(`- [${msToClock(cue.startMs)}] ${cue.text}`);
  }
  out.push('');
  return out.join('\n');
}

function chaptersMarkdown(insights, cues) {
  const chapters = Array.isArray(insights?.chapters) ? insights.chapters : [];
  if (chapters.length === 0) {
    const durationMs = cues.length > 0 ? cues[cues.length - 1].endMs : 0;
    const reason = durationMs < 180_000
      ? 'Media is too short for useful cached chapters, or no insight artifact exists yet.'
      : 'No cached insight chapters found. Generate AI Insights in Subcast, then export again.';
    return `# Chapters\n\n${reason}\n`;
  }
  const out = ['# Chapters', ''];
  for (const chapter of chapters) {
    out.push(`- [${msToClock(chapter.startMs)}] ${chapter.title}${chapter.description ? ` - ${chapter.description}` : ''}`);
  }
  out.push('');
  return out.join('\n');
}

function summaryMarkdown(insights) {
  const summary = typeof insights?.summary === 'string' ? insights.summary.trim() : '';
  const bullets = Array.isArray(insights?.summaryBullets) ? insights.summaryBullets : [];
  if (!summary && bullets.length === 0) {
    return '# Summary\n\nNo cached AI summary found. Generate AI Insights in Subcast, then export again.\n';
  }
  const out = ['# Summary', ''];
  if (summary) out.push(summary, '');
  for (const bullet of bullets) out.push(`- ${bullet}`);
  out.push('');
  return out.join('\n');
}

function makeSources(cues, title) {
  return cues.map((cue, index) => {
    const text = normalizeText(cue.text);
    return {
      id: `cue-${String(index + 1).padStart(5, '0')}`,
      fileId: 'primary',
      title,
      startMs: cue.startMs,
      endMs: cue.endMs,
      timestamp: msToClock(cue.startMs),
      speaker: null,
      snippet: text.slice(0, 240),
      snippetHash: snippetHash(text),
    };
  });
}

function nearestSourceId(sources, ms) {
  if (sources.length === 0) return null;
  let best = sources[0];
  let bestDistance = Math.abs(best.startMs - ms);
  for (const source of sources) {
    const distance = Math.abs(source.startMs - ms);
    if (distance < bestDistance) {
      best = source;
      bestDistance = distance;
    }
  }
  return best.id;
}

function genericDeliverable({ title, cues, insights, sources }) {
  const out = ['# Local Archive Pack', '', `Media: ${title}`, '', '## Contents', ''];
  out.push('- `manifest.json` - run metadata without raw local paths or transcript text.');
  out.push('- `transcript.md` - timestamped transcript.');
  out.push('- `subtitles.srt` - subtitle export from the same cue source.');
  out.push('- `chapters.md` - cached AI chapters when available.');
  out.push('- `summary.md` - cached AI summary when available.');
  out.push('- `sources.json` - cue-level source map for downstream agents.');
  out.push('');
  out.push('## Status', '');
  out.push(`- Cues: ${cues.length}`);
  out.push(`- Sources: ${sources.length}`);
  out.push(`- Cached summary: ${insights ? 'yes' : 'no'}`);
  out.push('');
  return out.join('\n');
}

function creatorDeliverable({ title, cues, insights, sources }) {
  const out = ['# Creator Editing Brief', '', `Media: ${title}`, ''];
  const chapters = Array.isArray(insights?.chapters) ? insights.chapters : [];
  if (chapters.length > 0) {
    out.push('## Chapter Outline', '');
    for (const chapter of chapters) {
      const sourceId = nearestSourceId(sources, chapter.startMs);
      out.push(`- [${msToClock(chapter.startMs)}] ${chapter.title}${chapter.description ? ` - ${chapter.description}` : ''}${sourceId ? ` (${sourceId})` : ''}`);
    }
    out.push('');
  } else {
    out.push('## Chapter Outline', '', 'No cached chapters found. Generate AI Insights in Subcast before scoring this case.', '');
  }

  out.push('## Clip Candidates For Human Review', '');
  const candidates = chapters.length > 0
    ? chapters.slice(0, 8).map((chapter) => ({
        startMs: chapter.startMs,
        endMs: Math.min(chapter.startMs + 90_000, cues[cues.length - 1]?.endMs ?? chapter.startMs + 90_000),
        reason: chapter.description || chapter.title,
      }))
    : cues.filter((cue) => normalizeText(cue.text).length >= 40).slice(0, 8).map((cue) => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        reason: 'Longer speech segment; review manually because no cached AI chapters are available.',
      }));
  for (const candidate of candidates) {
    const sourceId = nearestSourceId(sources, candidate.startMs);
    out.push(`- [${msToClock(candidate.startMs)}-${msToClock(candidate.endMs)}] ${candidate.reason}${sourceId ? ` (${sourceId})` : ''}`);
  }
  if (candidates.length === 0) out.push('- No clip candidates found from cached cues.');
  out.push('');
  out.push('## Risk Notes', '');
  out.push('- This adapter does not call an LLM; treat clip candidates as review targets, not final editorial judgment.');
  if (!insights) out.push('- Cached AI Insights are missing, so the brief is evidence-sparse.');
  out.push('- Verify any quotes against the timestamped transcript before publishing.');
  out.push('');
  return out.join('\n');
}

function meetingNotesDeliverable({ title, insights, sources }) {
  const out = ['# Meeting Notes Evidence Pack', '', `Media: ${title}`, ''];
  const chapters = Array.isArray(insights?.chapters) ? insights.chapters : [];
  const bullets = Array.isArray(insights?.summaryBullets) ? insights.summaryBullets : [];

  out.push('## Decisions', '');
  if (bullets.length > 0) {
    for (const bullet of bullets.slice(0, 6)) {
      out.push(`- Review candidate: ${bullet}`);
    }
  } else {
    out.push('- No cached summary bullets found.');
  }
  out.push('');

  out.push('## Action Items', '');
  out.push('- Not inferred by this adapter. Use the cited discussion points below to confirm owner and deadline manually.');
  out.push('');

  out.push('## Discussion Points To Review', '');
  if (chapters.length > 0) {
    for (const chapter of chapters) {
      const sourceId = nearestSourceId(sources, chapter.startMs);
      out.push(`- [${msToClock(chapter.startMs)}] ${chapter.title}${chapter.description ? ` - ${chapter.description}` : ''}${sourceId ? ` (${sourceId})` : ''}`);
    }
  } else {
    out.push('- No cached chapters found. Generate AI Insights in Subcast before scoring this case.');
  }
  out.push('');

  out.push('## Open Questions', '');
  out.push('- Not inferred by this adapter. Add questions only after reviewing cited transcript evidence.');
  out.push('');

  out.push('## Follow-Up Agenda', '');
  if (chapters.length > 0) {
    for (const chapter of chapters.slice(0, 5)) {
      const sourceId = nearestSourceId(sources, chapter.startMs);
      out.push(`- Revisit ${chapter.title}${sourceId ? ` (${sourceId})` : ''}`);
    }
  } else {
    out.push('- No agenda candidates found.');
  }
  out.push('');

  out.push('## Risk Notes', '');
  out.push('- Owners, deadlines, and decisions require human confirmation unless explicitly present in cited transcript text.');
  out.push('- This adapter does not call an LLM; it packages cached Subcast evidence for review.');
  out.push('');
  return out.join('\n');
}

function writeBundle({ args, db, video, transcribeTask, insightTask, insight, cues }) {
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const rawTitle = video.display_name || video.original_name || `subcast-${video.sha256.slice(0, 8)}`;
  const title = args.redactSourceName ? `subcast-${video.sha256.slice(0, 12)}` : rawTitle;
  const sources = makeSources(cues, title);
  const generatedAt = new Date().toISOString();
  const runId = `bundle-${Date.now().toString(36)}`;
  const manifest = {
    schemaVersion: 1,
    kind: 'subcast-artifact-bundle',
    runId,
    generatedAt,
    recipe: args.recipe,
    status: 'complete',
    input: {
      sha256: video.sha256,
      title,
      sourceNameRedacted: args.redactSourceName === true,
      ext: video.ext,
      sizeBytes: video.size_bytes,
      durationS: video.duration_s,
    },
    models: {
      transcribe: transcribeTask?.model ?? null,
      insight: insightTask?.model ?? null,
    },
    artifacts: {
      transcript: 'transcript.md',
      subtitles: 'subtitles.srt',
      chapters: 'chapters.md',
      summary: 'summary.md',
      sources: 'sources.json',
      deliverable: 'deliverable.md',
    },
    counts: {
      cues: cues.length,
      sources: sources.length,
      chapters: Array.isArray(insight?.payload?.chapters) ? insight.payload.chapters.length : 0,
    },
    sourceState: {
      subcastHome: process.env.SUBCAST_HOME ? 'env' : 'default',
      cacheOnly: video.cacheOnly === true,
      transcriptStatus: transcribeTask?.status ?? null,
      insightStatus: insightTask?.status ?? null,
      insightSource: insight?.source ?? null,
      diarizeStatus: db ? loadDiarizeTask(db, video.sha256)?.status ?? null : null,
    },
  };

  const sourcesEnvelope = {
    schemaVersion: 1,
    generatedAt,
    videoSha: video.sha256,
    title,
    sources,
    outputReferences: [],
  };
  if (Array.isArray(insight?.payload?.chapters)) {
    for (const chapter of insight.payload.chapters) {
      const sourceId = nearestSourceId(sources, chapter.startMs);
      if (sourceId) {
        sourcesEnvelope.outputReferences.push({
          artifact: 'chapters.md',
          section: chapter.title,
          sourceIds: [sourceId],
        });
      }
    }
  }

  const deliverable =
    args.recipe === 'creator-brief'
      ? creatorDeliverable({ title, cues, insights: insight?.payload, sources })
      : args.recipe === 'meeting-notes'
        ? meetingNotesDeliverable({ title, insights: insight?.payload, sources })
        : genericDeliverable({ title, cues, insights: insight?.payload, sources });

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outDir, 'transcript.md'), transcriptMarkdown(cues, title));
  writeFileSync(join(outDir, 'subtitles.srt'), serializeSrt(cues));
  writeFileSync(join(outDir, 'chapters.md'), chaptersMarkdown(insight?.payload, cues));
  writeFileSync(join(outDir, 'summary.md'), summaryMarkdown(insight?.payload));
  writeFileSync(join(outDir, 'sources.json'), `${JSON.stringify(sourcesEnvelope, null, 2)}\n`);
  writeFileSync(join(outDir, 'deliverable.md'), deliverable);
  return { outDir, manifest };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail('BAD_ARGS', err.message);
    console.error(usage());
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.hash || !HASH_RE.test(args.hash)) {
    fail('BAD_HASH', '--hash must be a Subcast video sha prefix/full sha with 12+ hex characters');
    return;
  }
  if (!args.out) {
    fail('NO_OUT', '--out is required');
    return;
  }
  if (!RECIPES.has(args.recipe)) {
    fail('BAD_RECIPE', `--recipe must be one of: ${[...RECIPES].join(', ')}`);
    return;
  }

  const home = resolve(args.home);
  const dbPath = join(home, 'data.sqlite');
  const db = existsSync(dbPath) ? new Database(dbPath, { readonly: true, fileMustExist: true }) : null;
  try {
    let video;
    if (db) {
      try {
        video = loadVideo(db, args.hash);
      } catch (err) {
        if (err instanceof Error && err.message === 'AMBIGUOUS_HASH') {
          fail('AMBIGUOUS_HASH', 'Hash prefix matches more than one video; pass a longer hash');
          return;
        }
        throw err;
      }
    }
    if (!video) {
      try {
        video = cacheOnlyVideo(home, args.hash);
      } catch (err) {
        if (err instanceof Error && err.message === 'AMBIGUOUS_HASH') {
          fail('AMBIGUOUS_HASH', 'Hash prefix matches more than one cache item; pass a longer hash');
          return;
        }
        throw err;
      }
    }
    if (!video) {
      fail('VIDEO_NOT_FOUND', 'No active video row or cache item found for hash');
      return;
    }
    const cacheDir = join(home, 'cache', video.sha256);
    const transcriptPath = join(cacheDir, 'original.vtt');
    if (!existsSync(transcriptPath)) {
      fail('NO_ORIGINAL_VTT', 'original.vtt is missing for this video');
      return;
    }
    const vtt = readFileSync(transcriptPath, 'utf8');
    const cues = parseVtt(vtt);
    if (cues.length === 0) {
      fail('NO_CUES', 'original.vtt parsed to zero cues');
      return;
    }
    const transcribeTask = db ? loadLatestTranscribeTask(db, video.sha256) : null;
    const insightTask = db ? loadInsightTask(db, video.sha256, args.lang) : null;
    const insight = loadLatestInsight(cacheDir, args.lang);
    if (args.requireInsights && !insight) {
      fail('INSIGHTS_REQUIRED', 'Cached AI Insights are required for this export');
      return;
    }
    const result = writeBundle({ args, db, video, transcribeTask, insightTask, insight, cues });
    console.log(JSON.stringify({
      ok: true,
      recipe: result.manifest.recipe,
      hash: result.manifest.input.sha256,
      cues: result.manifest.counts.cues,
      chapters: result.manifest.counts.chapters,
      insightSource: result.manifest.sourceState.insightSource,
      artifacts: Object.values(result.manifest.artifacts),
    }));
  } finally {
    if (db) db.close();
  }
}

main().catch((err) => {
  fail('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
});
