import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseVtt, type Cue } from './vtt';

export interface TranscribeOnceOptions {
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
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

function spawnAndWait(
  cmd: string,
  args: readonly string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/**
 * Slice 1: full-blocking transcribe via direct whisper-cli + ffmpeg.
 *
 * We deliberately bypass the `nodejs-whisper` JS wrapper because its shelljs
 * cd → relative-path approach breaks under pnpm in Nitro dev. We still depend
 * on the package for the prebuilt whisper.cpp tree (binary + models). Slice 3
 * will switch to chunk-level streaming via a long-running subprocess + stdin.
 */
export async function* transcribeOnce(
  absPath: string,
  opts: TranscribeOnceOptions = {},
): AsyncIterable<Cue> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `whisper-cli not built at ${CLI_PATH}. Run: cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli`,
    );
  }
  const model = opts.model ?? 'base';
  const modelPath = join(MODELS_DIR, `ggml-${model}.bin`);
  if (!existsSync(modelPath)) {
    throw new Error(
      `Model not downloaded: ${modelPath}. Run: npx nodejs-whisper download ${model}`,
    );
  }

  const wavPath = absPath.replace(/\.[^.]+$/, '.wav');
  const ofPrefix = absPath.replace(/\.[^.]+$/, '');

  const ff = await spawnAndWait('ffmpeg', [
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
  if (ff.code !== 0) {
    throw new Error(`ffmpeg audio extract failed: ${ff.stderr}`);
  }

  try {
    const wc = await spawnAndWait(CLI_PATH, [
      '-m',
      modelPath,
      '-f',
      wavPath,
      '--output-vtt',
      '-of',
      ofPrefix,
      '-l',
      'auto',
      '-ml',
      '20',
    ]);
    if (wc.code !== 0) {
      throw new Error(`whisper-cli failed: ${wc.stderr}`);
    }

    const vttPath = `${ofPrefix}.vtt`;
    const vtt = await readFile(vttPath, 'utf8');
    const cues = parseVtt(vtt);
    for (const cue of cues) {
      yield cue;
      await new Promise((r) => setTimeout(r, 20));
    }
    await unlink(vttPath).catch(() => {});
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}
