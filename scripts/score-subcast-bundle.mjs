#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const REQUIRED_FILES = [
  'manifest.json',
  'transcript.md',
  'subtitles.srt',
  'chapters.md',
  'summary.md',
  'sources.json',
  'deliverable.md',
];

function usage() {
  return [
    'Usage:',
    '  node scripts/score-subcast-bundle.mjs --bundle <dir> --rubric <rubric.json> [--out <score.json>]',
    '',
    'Scores a Subcast harness artifact bundle for structural blockers.',
    'This scorer does not judge editorial quality; humans still review task usefulness.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'bundle') args.bundle = value;
    else if (key === 'rubric') args.rubric = value;
    else if (key === 'out') args.out = value;
    else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, code, message }));
  process.exitCode = 1;
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function hasRawPath(text) {
  return /(?:^|["'\s])\/Users\/[^"'\s]+/.test(text) ||
    /(?:^|["'\s])\/tmp\/[^"'\s]+/.test(text) ||
    /(?:^|["'\s])[A-Za-z]:\\[^"'\s]+/.test(text);
}

const SRT_TIME_RE =
  /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

function srtMs(match, offset) {
  return Number(match[offset]) * 3_600_000 +
    Number(match[offset + 1]) * 60_000 +
    Number(match[offset + 2]) * 1_000 +
    Number(match[offset + 3]);
}

function parseSrtTimes(content) {
  const times = [];
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.trim().match(SRT_TIME_RE);
    if (!match) continue;
    times.push({ startMs: srtMs(match, 1), endMs: srtMs(match, 5) });
  }
  return times;
}

function scoreBundle(bundleDir, rubric) {
  const blockers = new Set();
  const warnings = [];
  const files = {};
  for (const file of REQUIRED_FILES) {
    const path = join(bundleDir, file);
    files[file] = existsSync(path);
  }

  if (!files['manifest.json']) blockers.add('missing_manifest');
  if (!files['sources.json']) blockers.add('missing_sources');

  let manifest = null;
  let sources = null;
  let manifestText = '';
  let sourcesText = '';
  let deliverable = '';
  let transcript = '';
  try {
    if (files['manifest.json']) {
      manifestText = readText(join(bundleDir, 'manifest.json'));
      manifest = JSON.parse(manifestText);
    }
  } catch {
    blockers.add('missing_manifest');
  }
  try {
    if (files['sources.json']) {
      sourcesText = readText(join(bundleDir, 'sources.json'));
      sources = JSON.parse(sourcesText);
    }
  } catch {
    blockers.add('missing_sources');
  }
  if (files['deliverable.md']) deliverable = readText(join(bundleDir, 'deliverable.md'));
  if (files['transcript.md']) transcript = readText(join(bundleDir, 'transcript.md'));

  if (hasRawPath(manifestText)) blockers.add('raw_local_path_in_log_or_manifest');
  if (hasRawPath(sourcesText)) warnings.push('raw_path_in_sources');
  if (transcript && (manifestText.includes(transcript.slice(0, 200)) || sourcesText.includes(transcript.slice(0, 200)))) {
    blockers.add('raw_transcript_in_log');
  }

  const sourceList = Array.isArray(sources?.sources) ? sources.sources : [];
  if (sourceList.length === 0) blockers.add('missing_sources');
  const outputReferences = Array.isArray(sources?.outputReferences) ? sources.outputReferences : [];
  const citedCueIds = deliverable.match(/\bcue-\d{5}\b/g) ?? [];
  const timestampCitations = deliverable.match(/\[\d{2}:\d{2}:\d{2}(?:-\d{2}:\d{2}:\d{2})?\]/g) ?? [];
  if (rubric.blockers?.includes('no_timestamped_citations') && timestampCitations.length === 0) {
    blockers.add('no_timestamped_citations');
  }
  if (rubric.blockers?.includes('no_timestamped_clip_candidates')) {
    const hasClipSection = /Clip Candidates/i.test(deliverable);
    if (!hasClipSection || timestampCitations.length === 0) blockers.add('no_timestamped_clip_candidates');
  }

  if (files['subtitles.srt']) {
    const times = parseSrtTimes(readText(join(bundleDir, 'subtitles.srt')));
    if (times.length === 0) blockers.add('invalid_srt');
    for (let i = 0; i < times.length; i++) {
      const time = times[i];
      if (time.endMs <= time.startMs) blockers.add('invalid_srt');
      if (i > 0 && time.startMs < times[i - 1].startMs) blockers.add('invalid_srt');
    }
  } else {
    blockers.add('invalid_srt');
  }

  if (manifest?.recipe === 'creator-brief' && manifest?.sourceState?.insightSource === null) {
    if (rubric.blockers?.includes('creator_brief_without_cached_insights')) {
      blockers.add('creator_brief_without_cached_insights');
    } else {
      warnings.push('creator_brief_without_cached_insights');
    }
  }
  if (manifest?.recipe === 'meeting-notes' && manifest?.sourceState?.insightSource === null) {
    if (rubric.blockers?.includes('meeting_notes_without_cached_insights')) {
      blockers.add('meeting_notes_without_cached_insights');
    } else {
      warnings.push('meeting_notes_without_cached_insights');
    }
  }

  const isGenericArchive = manifest?.recipe === 'generic-archive-pack';
  const hasDeliverableEvidence = citedCueIds.length > 0 || outputReferences.length > 0;
  const hasSourceMap = sourceList.length > 0;

  const categoryScores = {
    artifactCompleteness: REQUIRED_FILES.every((file) => files[file]) ? 100 : 0,
    citationCoverage: hasSourceMap && (isGenericArchive || hasDeliverableEvidence) ? 100 : 40,
    groundedness: hasDeliverableEvidence || isGenericArchive ? 80 : 50,
    taskUsefulness: 50,
    structureStability: manifest?.schemaVersion === 1 && sources?.schemaVersion === 1 ? 100 : 50,
    latency: 100,
    privacy: hasRawPath(manifestText) ? 0 : 100,
  };

  const weights = rubric.weights ?? {};
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + Number(value), 0) || 1;
  let weighted = 0;
  for (const [key, weight] of Object.entries(weights)) {
    weighted += (categoryScores[key] ?? 0) * Number(weight);
  }
  const score = blockers.size > 0 ? Math.min(Math.round(weighted / totalWeight), 79) : Math.round(weighted / totalWeight);
  const passScore = Number(rubric.passScore ?? 80);
  return {
    ok: blockers.size === 0 && score >= passScore,
    score,
    passScore,
    blockers: [...blockers],
    warnings,
    categoryScores,
    evidence: {
      requiredFiles: files,
      sourceCount: sourceList.length,
      outputReferenceCount: outputReferences.length,
      deliverableCueCitationCount: citedCueIds.length,
      deliverableTimestampCitationCount: timestampCitations.length,
      recipe: manifest?.recipe ?? null,
      insightSource: manifest?.sourceState?.insightSource ?? null,
    },
  };
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
  if (!args.bundle) {
    fail('NO_BUNDLE', '--bundle is required');
    return;
  }
  if (!args.rubric) {
    fail('NO_RUBRIC', '--rubric is required');
    return;
  }
  const bundleDir = resolve(args.bundle);
  const rubricPath = resolve(args.rubric);
  if (!existsSync(bundleDir)) {
    fail('BUNDLE_NOT_FOUND', 'Bundle directory was not found');
    return;
  }
  if (!existsSync(rubricPath)) {
    fail('RUBRIC_NOT_FOUND', 'Rubric file was not found');
    return;
  }
  const result = scoreBundle(bundleDir, readJson(rubricPath));
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(args.out), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  fail('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
});
