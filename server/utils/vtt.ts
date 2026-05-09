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
