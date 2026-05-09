import { readFile } from 'node:fs/promises';
import { nodewhisper } from 'nodejs-whisper';
import { parseVtt, type Cue } from './vtt';

export interface TranscribeOnceOptions {
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
}

/**
 * Slice 1: full-blocking transcribe. nodejs-whisper writes a .vtt next to the
 * input file; we read it and yield cues one-by-one with a tiny delay so the
 * SSE consumer sees a stream-like progression. Real chunk-level streaming is
 * Slice 3's job.
 */
export async function* transcribeOnce(
  absPath: string,
  opts: TranscribeOnceOptions = {},
): AsyncIterable<Cue> {
  await nodewhisper(absPath, {
    modelName: opts.model ?? 'base',
    autoDownloadModelName: opts.model ?? 'base',
    // @ts-expect-error nodejs-whisper has weak/incomplete option typings
    removeWavFileAfterExecution: true,
    withCuda: false,
    whisperOptions: {
      outputInVtt: true,
      timestamps_length: 20,
      splitOnWord: false,
    },
  });
  const vttPath = absPath.replace(/\.[^.]+$/, '.vtt');
  const vtt = await readFile(vttPath, 'utf8');
  const cues = parseVtt(vtt);
  for (const cue of cues) {
    yield cue;
    await new Promise((r) => setTimeout(r, 20));
  }
}
