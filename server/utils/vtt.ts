export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMESTAMP_RE =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

function tsToMs(h: string, m: string, s: string, ms: string): number {
  return (
    parseInt(h, 10) * 3_600_000 +
    parseInt(m, 10) * 60_000 +
    parseInt(s, 10) * 1_000 +
    parseInt(ms, 10)
  );
}

function msToTs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const k = ms % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(k).padStart(3, '0')}`;
}

export function serializeVtt(cues: readonly Cue[]): string {
  const out = ['WEBVTT', ''];
  for (const cue of cues) {
    out.push(`${msToTs(cue.startMs)} --> ${msToTs(cue.endMs)}`);
    out.push(cue.text);
    out.push('');
  }
  return out.join('\n');
}

export function parseVtt(content: string): Cue[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i]?.match(TIMESTAMP_RE);
    if (!match) {
      i++;
      continue;
    }
    const startMs = tsToMs(match[1]!, match[2]!, match[3]!, match[4]!);
    const endMs = tsToMs(match[5]!, match[6]!, match[7]!, match[8]!);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      textLines.push(lines[i]!);
      i++;
    }
    if (textLines.length > 0) {
      cues.push({ startMs, endMs, text: textLines.join('\n') });
    }
  }
  return cues;
}
