/* SPDX-License-Identifier: Apache-2.0 */
import type { Cue } from './vtt';

const SRT_TS = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function tsToMs(h: string, m: string, s: string, ms: string): number {
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(m, 10) * 60_000 +
    parseInt(s, 10) * 1_000 +
    parseInt(ms, 10)
  );
}

/**
 * Parse SRT (also tolerates VTT and basic ASS lines that look SRT-ish).
 * Strips numeric counter lines, ASS dialogue prefixes, and HTML/SSA
 * formatting tags. The returned cues use absolute milliseconds matching
 * `vtt.ts` Cue shape.
 */
export function parseSrt(content: string): Cue[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    // Skip empty / counter / WEBVTT header
    if (line === '' || /^\d+$/.test(line) || line.startsWith('WEBVTT')) {
      i++;
      continue;
    }
    const m = line.match(SRT_TS);
    if (!m) {
      // ASS Dialogue: 0,0:00:01.50,0:00:04.00,...
      const ass = line.match(
        /^Dialogue:\s*\d+,(\d+):(\d{2}):(\d{2})\.(\d{2}),(\d+):(\d{2}):(\d{2})\.(\d{2}),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/,
      );
      if (ass) {
        const start = tsToMs(ass[1]!, ass[2]!, ass[3]!, (ass[4]! + '0').slice(0, 3));
        const end = tsToMs(ass[5]!, ass[6]!, ass[7]!, (ass[8]! + '0').slice(0, 3));
        const text = ass[9]!
          .replace(/\\N/g, '\n')
          .replace(/\{[^}]*\}/g, '')
          .trim();
        if (text) cues.push({ startMs: start, endMs: end, text });
      }
      i++;
      continue;
    }
    const start = tsToMs(m[1]!, m[2]!, m[3]!, m[4]!);
    const end = tsToMs(m[5]!, m[6]!, m[7]!, m[8]!);
    i++;
    const text: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      text.push(lines[i]!);
      i++;
    }
    const cleaned = text
      .join('\n')
      .replace(/<[^>]+>/g, '') // strip HTML/SSA tags
      .trim();
    if (cleaned) cues.push({ startMs: start, endMs: end, text: cleaned });
  }
  return cues;
}

/**
 * Convert any subtitle-ish content (.srt / .vtt / .ass) to a Cue[]. Caller
 * picks the parser based on extension.
 */
export function parseSubtitleByExt(content: string, _ext: string): Cue[] {
  // Both VTT and SRT use the same timestamp shape (vtt uses '.', srt uses ',')
  // and parseSrt above handles both. ASS lines are matched via the `Dialogue:`
  // pattern.
  return parseSrt(content);
}

function msToSrtTs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const k = ms % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(k).padStart(3, '0')}`;
}

export function serializeSrt(cues: readonly Cue[]): string {
  const parts: string[] = [];
  cues.forEach((cue, i) => {
    parts.push(String(i + 1));
    parts.push(`${msToSrtTs(cue.startMs)} --> ${msToSrtTs(cue.endMs)}`);
    parts.push(cue.text);
    parts.push('');
  });
  return cues.length === 0 ? '' : parts.join('\n') + '\n';
}

export function serializeBilingualSrt(
  original: readonly Cue[],
  translated: readonly Cue[],
): string {
  if (original.length !== translated.length) {
    throw new Error(`bilingual cue count mismatch: ${original.length} vs ${translated.length}`);
  }
  const parts: string[] = [];
  original.forEach((cue, i) => {
    const t = translated[i]!;
    if (cue.startMs !== t.startMs || cue.endMs !== t.endMs) {
      throw new Error(
        `bilingual timestamp mismatch at cue ${i}: ` +
        `original ${cue.startMs}-${cue.endMs} vs translated ${t.startMs}-${t.endMs}`,
      );
    }
    parts.push(String(i + 1));
    parts.push(`${msToSrtTs(cue.startMs)} --> ${msToSrtTs(cue.endMs)}`);
    parts.push(`${cue.text}\n${t.text}`);
    parts.push('');
  });
  return original.length === 0 ? '' : parts.join('\n') + '\n';
}
