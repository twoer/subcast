export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
  id?: number | string;
}

export function formatSse(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  lines.push('', '');
  return lines.join('\n');
}
