import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseVtt, type Cue } from './vtt';

export interface TranscribeOptions {
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo';
  /** Whisper sampling temperature. Default 0 (greedy). Higher = more diverse. */
  temperature?: number;
  /**
   * If true, pass --no-context to whisper-cli (i.e., disable
   * condition_on_previous_text). Used by F2 hallucination retries when the
   * default greedy pass produces repetitive output.
   */
  noContext?: boolean;
}

const NW_ROOT = join(
  process.cwd(),
  'node_modules',
  'nodejs-whisper',
  'cpp',
  'whisper.cpp',
);
const CLI_PATH = join(NW_ROOT, 'build', 'bin', 'whisper-cli');
const MODELS_DIR = join(NW_ROOT, 'models');

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnAndWait(cmd: string, args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function probeDurationS(absPath: string): Promise<number> {
  const r = await spawnAndWait('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    absPath,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  const v = parseFloat(r.stdout.trim());
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`ffprobe returned invalid duration: ${r.stdout}`);
  }
  return v;
}

export async function extractWav(absPath: string, wavPath: string): Promise<void> {
  const r = await spawnAndWait('ffmpeg', [
    '-i',
    absPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wavPath,
    '-y',
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg extract failed: ${r.stderr}`);
}

function assertWhisperReady(model: string): string {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `whisper-cli not built at ${CLI_PATH}. Run: cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli`,
    );
  }
  const modelPath = join(MODELS_DIR, `ggml-${model}.bin`);
  if (!existsSync(modelPath)) {
    throw new Error(
      `Model not downloaded: ${modelPath}. Run: npx nodejs-whisper download ${model}`,
    );
  }
  return modelPath;
}

/**
 * Slice the wav at [startSec, endSec) and transcribe just that segment via
 * whisper-cli. Returns cues with timestamps **adjusted to absolute time** in
 * the source video (i.e., already offset by startSec*1000).
 *
 * Caller is responsible for the parent wav's lifecycle. This function cleans
 * up its own per-chunk wav slice and VTT artifact.
 */
export async function transcribeChunk(
  wavPath: string,
  chunkIdx: number,
  chunkSizeSec: number,
  totalDurationSec: number,
  opts: TranscribeOptions = {},
): Promise<Cue[]> {
  const model = opts.model ?? 'base';
  const modelPath = assertWhisperReady(model);

  const startSec = chunkIdx * chunkSizeSec;
  const endSec = Math.min(startSec + chunkSizeSec, totalDurationSec);
  const sliceWavPath = wavPath.replace(/\.wav$/, `-chunk${chunkIdx}.wav`);

  const ff = await spawnAndWait('ffmpeg', [
    '-i',
    wavPath,
    '-ss',
    String(startSec),
    '-to',
    String(endSec),
    '-c:a',
    'pcm_s16le',
    sliceWavPath,
    '-y',
  ]);
  if (ff.code !== 0) {
    throw new Error(`ffmpeg slice chunk ${chunkIdx} failed: ${ff.stderr}`);
  }

  const ofPrefix = sliceWavPath.replace(/\.wav$/, '');
  try {
    // NOTE: do NOT pass `-ml N` here. whisper.cpp's max-segment-length
    // truncation is byte-oriented and slices CJK characters mid-UTF-8,
    // producing U+FFFD replacement chars for Chinese / Japanese / Korean
    // input. Letting whisper segment at natural silence boundaries gives
    // longer-but-clean cues that the cue list still renders fine.
    const args: string[] = [
      '-m', modelPath,
      '-f', sliceWavPath,
      '--output-vtt',
      '-of', ofPrefix,
      '-l', 'auto',
    ];
    if (typeof opts.temperature === 'number') {
      args.push('-tp', String(opts.temperature));
    }
    if (opts.noContext) {
      // whisper-cli has no `--no-context`; set max-context tokens to 0,
      // which disables condition_on_previous_text equivalently.
      args.push('-mc', '0');
    }
    const wc = await spawnAndWait(CLI_PATH, args);
    if (wc.code !== 0) {
      throw new Error(`whisper-cli chunk ${chunkIdx} failed: ${wc.stderr}`);
    }

    const vttPath = `${ofPrefix}.vtt`;
    const vtt = await readFile(vttPath, 'utf8');
    const rawCues = parseVtt(vtt);
    await unlink(vttPath).catch(() => {});

    const offsetMs = Math.round(startSec * 1000);
    return rawCues.map((cue) => ({
      startMs: cue.startMs + offsetMs,
      endMs: cue.endMs + offsetMs,
      text: cue.text,
    }));
  } finally {
    await unlink(sliceWavPath).catch(() => {});
  }
}
