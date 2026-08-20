/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import JSZip from 'jszip';

import type { VideoRow } from '../types/db';
import { getDb, SUBCAST_PATHS } from './db';
import { serializeSrt } from './srt';
import type { Cue } from './vtt';
import { parseVtt } from './vtt';

export type SubcastBundleRecipe = 'generic-archive-pack' | 'creator-brief' | 'meeting-notes';
type InsightLanguage = 'zh-CN' | 'en';
type InsightPayload = {
  summary?: string;
  summaryBullets?: string[];
  chapters?: Array<{
    startMs: number;
    title: string;
    description?: string;
  }>;
};

export interface SubcastBundleZipResult {
  filename: string;
  buffer: Buffer;
  manifest: {
    recipe: SubcastBundleRecipe;
    input: {
      sha256: string;
      title: string;
      sourceNameRedacted: true;
      ext: string;
      sizeBytes: number | null;
      durationS: number | null;
    };
    counts: {
      cues: number;
      sources: number;
      chapters: number;
    };
    artifacts: Record<string, string>;
  };
}

interface SourceRef {
  id: string;
  fileId: 'primary';
  title: string;
  startMs: number;
  endMs: number;
  timestamp: string;
  speaker: null;
  snippet: string;
  snippetHash: string;
}

function msToClock(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function snippetHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function transcriptMarkdown(cues: readonly Cue[], title: string): string {
  const out = ['# Transcript', '', `Source: ${title}`, ''];
  for (const cue of cues) out.push(`- [${msToClock(cue.startMs)}] ${cue.text}`);
  out.push('');
  return out.join('\n');
}

function chaptersMarkdown(insights: InsightPayload | null, cues: readonly Cue[]): string {
  const chapters = Array.isArray(insights?.chapters) ? insights.chapters : [];
  if (chapters.length === 0) {
    const durationMs = cues.length > 0 ? cues[cues.length - 1]!.endMs : 0;
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

function summaryMarkdown(insights: InsightPayload | null): string {
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

function makeSources(cues: readonly Cue[], title: string): SourceRef[] {
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

function nearestSourceId(sources: readonly SourceRef[], ms: number): string | null {
  if (sources.length === 0) return null;
  let best = sources[0]!;
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

function genericDeliverable(title: string, cues: readonly Cue[], insights: InsightPayload | null, sources: readonly SourceRef[]): string {
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

function creatorDeliverable(title: string, cues: readonly Cue[], insights: InsightPayload, sources: readonly SourceRef[]): string {
  const out = ['# Creator Editing Brief', '', `Media: ${title}`, '', '## Chapter Outline', ''];
  const chapters = Array.isArray(insights.chapters) ? insights.chapters : [];
  for (const chapter of chapters) {
    const sourceId = nearestSourceId(sources, chapter.startMs);
    out.push(`- [${msToClock(chapter.startMs)}] ${chapter.title}${chapter.description ? ` - ${chapter.description}` : ''}${sourceId ? ` (${sourceId})` : ''}`);
  }
  if (chapters.length === 0) out.push('- No cached chapters found.');

  out.push('', '## Clip Candidates For Human Review', '');
  const lastCueEndMs = cues[cues.length - 1]?.endMs ?? 0;
  for (const chapter of chapters.slice(0, 8)) {
    const sourceId = nearestSourceId(sources, chapter.startMs);
    const endMs = Math.min(chapter.startMs + 90_000, lastCueEndMs || chapter.startMs + 90_000);
    out.push(`- [${msToClock(chapter.startMs)}-${msToClock(endMs)}] ${chapter.description || chapter.title}${sourceId ? ` (${sourceId})` : ''}`);
  }
  if (chapters.length === 0) out.push('- No clip candidates found from cached AI chapters.');

  out.push('', '## Risk Notes', '');
  out.push('- Treat clip candidates as human review targets, not final editorial judgment.');
  out.push('- Verify any quotes against the timestamped transcript before publishing.', '');
  return out.join('\n');
}

function meetingNotesDeliverable(title: string, insights: InsightPayload, sources: readonly SourceRef[]): string {
  const out = ['# Meeting Notes Evidence Pack', '', `Media: ${title}`, '', '## Decisions', ''];
  const bullets = Array.isArray(insights.summaryBullets) ? insights.summaryBullets : [];
  for (const bullet of bullets.slice(0, 6)) out.push(`- Review candidate: ${bullet}`);
  if (bullets.length === 0) out.push('- No cached summary bullets found.');

  out.push('', '## Action Items', '');
  out.push('- Not inferred by this export. Confirm owner and deadline against cited transcript evidence.', '');

  out.push('## Discussion Points To Review', '');
  const chapters = Array.isArray(insights.chapters) ? insights.chapters : [];
  for (const chapter of chapters) {
    const sourceId = nearestSourceId(sources, chapter.startMs);
    out.push(`- [${msToClock(chapter.startMs)}] ${chapter.title}${chapter.description ? ` - ${chapter.description}` : ''}${sourceId ? ` (${sourceId})` : ''}`);
  }
  if (chapters.length === 0) out.push('- No cached chapters found.');

  out.push('', '## Open Questions', '');
  out.push('- Not inferred by this export. Add questions only after reviewing cited transcript evidence.', '');
  out.push('## Follow-Up Agenda', '');
  for (const chapter of chapters.slice(0, 5)) {
    const sourceId = nearestSourceId(sources, chapter.startMs);
    out.push(`- Revisit ${chapter.title}${sourceId ? ` (${sourceId})` : ''}`);
  }
  if (chapters.length === 0) out.push('- No agenda candidates found.');

  out.push('', '## Risk Notes', '');
  out.push('- Owners, deadlines, and decisions require human confirmation unless explicit in cited transcript text.', '');
  return out.join('\n');
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function loadLatestInsightPayload(hash: string, lang: InsightLanguage): { payload: InsightPayload; source: string } | null {
  const cacheDir = join(SUBCAST_PATHS.cache, hash);
  const artifactDir = join(cacheDir, 'artifacts', 'insight');
  const pointer = readJsonFile<{ fingerprint?: string; filename?: string }>(
    join(artifactDir, `latest-${lang}.json`),
  );
  if (pointer?.fingerprint && pointer.filename) {
    const artifact = readJsonFile<{
      kind?: string;
      uiLanguage?: string;
      fingerprint?: string;
      payload?: InsightPayload;
    }>(join(artifactDir, basename(pointer.filename)));
    if (
      artifact?.kind === 'insight'
      && artifact.uiLanguage === lang
      && artifact.fingerprint === pointer.fingerprint
      && artifact.payload
    ) {
      return { payload: artifact.payload, source: 'artifact' };
    }
  }

  const legacy = readJsonFile<InsightPayload>(join(cacheDir, 'insights.json'));
  return legacy ? { payload: legacy, source: 'legacy' } : null;
}

export async function buildMediaBundleZip(
  hash: string,
  recipe: SubcastBundleRecipe,
  lang: InsightLanguage = 'zh-CN',
): Promise<SubcastBundleZipResult> {
  const db = getDb();
  const row = db
    .prepare('SELECT sha256, ext, size_bytes, duration_s FROM videos WHERE sha256 = ?')
    .get(hash) as Pick<VideoRow, 'sha256' | 'ext' | 'size_bytes' | 'duration_s'> | undefined;
  if (!row) {
    const err = new Error('VIDEO_NOT_FOUND');
    err.name = 'VIDEO_NOT_FOUND';
    throw err;
  }

  const transcriptPath = join(SUBCAST_PATHS.cache, hash, 'original.vtt');
  if (!existsSync(transcriptPath)) {
    const err = new Error('NO_ORIGINAL_VTT');
    err.name = 'NO_ORIGINAL_VTT';
    throw err;
  }

  const cues = parseVtt(readFileSync(transcriptPath, 'utf8'));
  if (cues.length === 0) {
    const err = new Error('NO_CUES');
    err.name = 'NO_CUES';
    throw err;
  }

  const title = `subcast-${hash.slice(0, 12)}`;
  const sources = makeSources(cues, title);
  const insight = loadLatestInsightPayload(hash, lang);
  if (recipe !== 'generic-archive-pack' && !insight) {
    const err = new Error('INSIGHTS_REQUIRED');
    err.name = 'INSIGHTS_REQUIRED';
    throw err;
  }
  const artifacts = {
    transcript: 'transcript.md',
    subtitles: 'subtitles.srt',
    chapters: 'chapters.md',
    summary: 'summary.md',
    sources: 'sources.json',
    deliverable: 'deliverable.md',
  };
  const manifest: SubcastBundleZipResult['manifest'] & Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'subcast-artifact-bundle',
    runId: `bundle-${Date.now().toString(36)}`,
    generatedAt: new Date().toISOString(),
    recipe,
    status: 'complete',
    input: {
      sha256: hash,
      title,
      sourceNameRedacted: true,
      ext: row.ext,
      sizeBytes: row.size_bytes,
      durationS: row.duration_s,
    },
    artifacts,
    counts: {
      cues: cues.length,
      sources: sources.length,
      chapters: Array.isArray(insight?.payload.chapters) ? insight.payload.chapters.length : 0,
    },
    sourceState: {
      transcriptStatus: 'cached',
      insightSource: insight?.source ?? null,
    },
  };
  const sourcesEnvelope = {
    schemaVersion: 1,
    generatedAt: manifest.generatedAt,
    videoSha: hash,
    title,
    sources,
    outputReferences: [] as Array<{
      artifact: string;
      section: string;
      sourceIds: string[];
    }>,
  };
  if (Array.isArray(insight?.payload.chapters)) {
    for (const chapter of insight.payload.chapters) {
      const sourceId = nearestSourceId(sources, chapter.startMs);
      if (sourceId) {
        sourcesEnvelope.outputReferences.push({
          artifact: artifacts.chapters,
          section: chapter.title,
          sourceIds: [sourceId],
        });
      }
    }
  }
  if (recipe !== 'generic-archive-pack' && Array.isArray(insight?.payload.chapters)) {
    for (const chapter of insight.payload.chapters) {
      const sourceId = nearestSourceId(sources, chapter.startMs);
      if (sourceId) {
        sourcesEnvelope.outputReferences.push({
          artifact: artifacts.deliverable,
          section: chapter.title,
          sourceIds: [sourceId],
        });
      }
    }
  }

  const deliverable = recipe === 'creator-brief'
    ? creatorDeliverable(title, cues, insight!.payload, sources)
    : recipe === 'meeting-notes'
      ? meetingNotesDeliverable(title, insight!.payload, sources)
      : genericDeliverable(title, cues, insight?.payload ?? null, sources);

  const zip = new JSZip();
  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file(artifacts.transcript, transcriptMarkdown(cues, title));
  zip.file(artifacts.subtitles, serializeSrt(cues));
  zip.file(artifacts.chapters, chaptersMarkdown(insight?.payload ?? null, cues));
  zip.file(artifacts.summary, summaryMarkdown(insight?.payload ?? null));
  zip.file(artifacts.sources, `${JSON.stringify(sourcesEnvelope, null, 2)}\n`);
  zip.file(artifacts.deliverable, deliverable);

  return {
    filename: `${title}.skill-bundle.zip`,
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    manifest: manifest as SubcastBundleZipResult['manifest'],
  };
}

export function buildGenericArchiveBundleZip(
  hash: string,
  lang: InsightLanguage = 'zh-CN',
): Promise<SubcastBundleZipResult> {
  return buildMediaBundleZip(hash, 'generic-archive-pack', lang);
}
