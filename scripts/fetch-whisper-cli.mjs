#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Stage the locally built whisper.cpp sidecar into binaries/<platform>-<arch>
 * so electron-builder can bundle it via extraResources.
 *
 * macOS whisper-cli is dynamically linked against libwhisper + libggml*.dylib;
 * copy those dylibs into whisper-libs/ next to the executable. afterPack then
 * rewrites rpaths to @loader_path so the packaged app is portable.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const target = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : `${process.platform}-${process.arch}`;
const isWin = target.startsWith('win32');
const isDarwin = target.startsWith('darwin');
const ext = isWin ? '.exe' : '';

const destDir = join(REPO, 'binaries', target);
const destBinary = join(destDir, `whisper-cli${ext}`);
const destLibs = join(destDir, 'whisper-libs');

// Skip the fetch/rebuild when a complete whisper-cli was already staged
// (e.g. by release.yml's download-artifact step, or by a prior local run).
// On mac the staged layout must include whisper-libs/*.dylib because the
// binary is dynamically linked — without them electron-builder would warn
// and the packaged app would fail to load whisper-cli on another machine.
// This guard prevents the on-the-fly cmake rebuild from clobbering a
// pre-built CI artifact.
const hasStagedLibs = !isDarwin
  || (existsSync(destLibs)
    && readdirSync(destLibs).some((e) => /^lib(?:whisper|ggml).*\.dylib$/.test(e)));
if (existsSync(destBinary) && hasStagedLibs) {
  console.log(`[fetch-whisper-cli] ${destBinary} already staged, skipping fetch/rebuild`);
  process.exit(0);
}

const WHISPER_ROOT = join(REPO, 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp');
const WHISPER_BUILD_DIR = join(WHISPER_ROOT, 'build');
if (isDarwin) {
  rebuildDarwinWhisperWithStableFilePaths();
}

const binaryCandidates = isWin
  ? [
      join(WHISPER_BUILD_DIR, 'bin', 'Release', `whisper-cli${ext}`),
      join(WHISPER_BUILD_DIR, 'bin', `whisper-cli${ext}`),
    ]
  : [join(WHISPER_BUILD_DIR, 'bin', `whisper-cli${ext}`)];
const sourceBinary = binaryCandidates.find((p) => existsSync(p));

if (!sourceBinary) {
  console.error(
    `[fetch-whisper-cli] whisper-cli not found. Build it first:\n` +
      `  cd node_modules/nodejs-whisper/cpp/whisper.cpp\n` +
      `  cmake -S . -B build -DWHISPER_METAL=ON -DWHISPER_ACCELERATE=ON\n` +
      `  cmake --build build --target whisper-cli -j`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(sourceBinary, destBinary);
chmodSync(destBinary, 0o755);
stripMachODebugSymbols(destBinary);
console.log(`[fetch-whisper-cli] copied ${sourceBinary} -> ${destBinary}`);

if (isDarwin) {
  const libDirs = [
    join(WHISPER_BUILD_DIR, 'src'),
    join(WHISPER_BUILD_DIR, 'ggml', 'src'),
    join(WHISPER_BUILD_DIR, 'ggml', 'src', 'ggml-blas'),
    join(WHISPER_BUILD_DIR, 'ggml', 'src', 'ggml-metal'),
  ];
  const libsDir = join(destDir, 'whisper-libs');
  rmSync(libsDir, { recursive: true, force: true });
  mkdirSync(libsDir, { recursive: true });

  let count = 0;
  for (const dir of libDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!/^lib(?:whisper|ggml).*\.dylib$/.test(entry)) continue;
      const src = join(dir, entry);
      if (!statSync(src).isFile()) continue;
      const dest = join(libsDir, entry);
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
      stripMachODebugSymbols(dest);
      count += 1;
    }
  }

  if (count === 0) {
    console.error(`[fetch-whisper-cli] no whisper dylibs found under ${dirname(sourceBinary)}`);
    process.exit(1);
  }
  console.log(`[fetch-whisper-cli] copied ${count} dylib(s) -> ${libsDir}`);
}

function stripMachODebugSymbols(file) {
  if (!isDarwin) return;
  const result = spawnSync('strip', ['-S', file], { encoding: 'utf8' });
  if (result.status === 0) return;
  const msg = (result.stderr || result.stdout || '').trim();
  console.warn(`[fetch-whisper-cli] strip -S failed for ${file}${msg ? `: ${msg}` : ''}`);
}

function rebuildDarwinWhisperWithStableFilePaths() {
  const prefixFlags = [
    `-ffile-prefix-map=${WHISPER_ROOT}=whisper.cpp`,
    `-ffile-prefix-map=${WHISPER_BUILD_DIR}=whisper.cpp/build`,
    `-ffile-prefix-map=${REPO}=subcast`,
  ].join(' ');
  const common = [
    '-S', WHISPER_ROOT,
    '-B', WHISPER_BUILD_DIR,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DWHISPER_METAL=ON',
    '-DWHISPER_ACCELERATE=ON',
    `-DCMAKE_C_FLAGS=${prefixFlags}`,
    `-DCMAKE_CXX_FLAGS=${prefixFlags}`,
  ];
  run('cmake', common);
  run('cmake', ['--build', WHISPER_BUILD_DIR, '--target', 'whisper-cli', '-j']);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status === 0) return;
  const code = result.status ?? result.signal ?? 'unknown';
  console.error(`[fetch-whisper-cli] ${command} failed (${code})`);
  process.exit(1);
}
