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
import { join } from 'node:path';
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
const destServerBinary = join(destDir, `whisper-server${ext}`);
const destLibs = join(destDir, 'whisper-libs');

// Skip the fetch/rebuild when a complete whisper staging was already
// laid down (e.g. by release.yml's download-artifact step, or by a prior
// local run). On mac the staged layout must include whisper-libs/*.dylib
// because the binaries are dynamically linked — without them
// electron-builder would warn and the packaged app would fail to load
// whisper-cli on another machine. whisper-server is part of the complete
// staging (resident-model accelerator); an older staging without it
// re-runs so the server lands too.
// This guard prevents the on-the-fly cmake rebuild from clobbering a
// pre-built CI artifact.
const hasStagedLibs = !isDarwin
  || (existsSync(destLibs)
    && readdirSync(destLibs).some((e) => /^lib(?:whisper|ggml).*\.dylib$/.test(e)));
if (
  existsSync(destBinary)
  && existsSync(destServerBinary)
  && hasStagedLibs
) {
  console.log(`[fetch-whisper-cli] ${destBinary} + whisper-server already staged, skipping fetch/rebuild`);
  // A staged CI artifact still carries the BUILD machine's absolute rpaths
  // (release.yml's afterPack only fixes the copy inside the .app). Dev mode
  // spawns this file directly, so normalize rpaths here — idempotent.
  ensureMacSidecarRpaths(destBinary, destLibs);
  ensureMacSidecarRpaths(destServerBinary, destLibs);
  process.exit(0);
}

const WHISPER_ROOT = join(REPO, 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp');
const WHISPER_BUILD_DIR = join(WHISPER_ROOT, 'build');
if (isDarwin) {
  rebuildDarwinWhisperWithStableFilePaths();
}

const binaryCandidates = (name) =>
  isWin
    ? [
        join(WHISPER_BUILD_DIR, 'bin', 'Release', `${name}${ext}`),
        join(WHISPER_BUILD_DIR, 'bin', `${name}${ext}`),
      ]
    : [join(WHISPER_BUILD_DIR, 'bin', `${name}${ext}`)];
const binaries = ['whisper-cli', 'whisper-server'].map((name) => {
  const source = binaryCandidates(name).find((p) => existsSync(p));
  return { name, source, dest: join(destDir, `${name}${ext}`) };
});
const missing = binaries.filter((b) => !b.source);
if (missing.length > 0) {
  console.error(
    `[fetch-whisper-cli] ${missing.map((b) => b.name).join(', ')} not found. Build them first:\n` +
      `  cd node_modules/nodejs-whisper/cpp/whisper.cpp\n` +
      `  cmake -S . -B build -DWHISPER_METAL=ON -DWHISPER_ACCELERATE=ON\n` +
      `  cmake --build build --target whisper-cli --target whisper-server -j`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
for (const { source, dest } of binaries) {
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
  stripMachODebugSymbols(dest);
  console.log(`[fetch-whisper-cli] copied ${source} -> ${dest}`);
}

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
    console.error(`[fetch-whisper-cli] no whisper dylibs found under ${join(WHISPER_BUILD_DIR, 'src')}`);
    process.exit(1);
  }
  console.log(`[fetch-whisper-cli] copied ${count} dylib(s) -> ${libsDir}`);
  // A local cmake build has the same problem as a CI artifact: rpaths point
  // at the build tree, which only exists on this machine for as long as
  // node_modules survives. Normalize for portable dev-mode spawning.
  ensureMacSidecarRpaths(destBinary, destLibs);
  ensureMacSidecarRpaths(destServerBinary, destLibs);
}

/**
 * Rewrite the sidecar's rpath layout to the self-contained form the
 * packaged app uses (afterPack's fixSidecarDylibs): binary →
 * `@loader_path/whisper-libs`, dylibs → `@loader_path` + `@rpath/<name>`
 * install ids, then re-apply the ad-hoc signature (install_name_tool
 * invalidates it). Idempotent — exits early when the binary already has
 * the desired rpath. Best-effort: failures warn but don't fail staging,
 * mirroring afterPack's tolerance.
 */
function ensureMacSidecarRpaths(binary, libsDir) {
  if (!isDarwin) return;
  const rpathsOf = (file) => {
    const res = spawnSync('otool', ['-l', file], { encoding: 'utf8' });
    if (res.status !== 0) return null;
    return [...String(res.stdout).matchAll(/LC_RPATH[\s\S]*?path (.+?) \(offset \d+\)/g)].map(
      (m) => m[1],
    );
  };
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0) {
      console.warn(`[fetch-whisper-cli] ${cmd} ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
      return false;
    }
    return true;
  };

  const rpaths = rpathsOf(binary);
  if (rpaths === null) return;
  if (rpaths.includes('@loader_path/whisper-libs') && rpaths.length === 1) return; // already normalized

  for (const rp of rpaths) run('install_name_tool', ['-delete_rpath', rp, binary]);
  if (!rpaths.includes('@loader_path/whisper-libs')) {
    run('install_name_tool', ['-add_rpath', '@loader_path/whisper-libs', binary]);
  }
  for (const entry of readdirSync(libsDir)) {
    if (!entry.endsWith('.dylib')) continue;
    const lib = join(libsDir, entry);
    for (const rp of rpathsOf(lib) ?? []) run('install_name_tool', ['-delete_rpath', rp, lib]);
    run('install_name_tool', ['-add_rpath', '@loader_path', lib]);
    run('install_name_tool', ['-id', `@rpath/${entry}`, lib]);
    run('codesign', ['--force', '--sign', '-', lib]);
  }
  run('codesign', ['--force', '--sign', '-', binary]);
  console.log('[fetch-whisper-cli] normalized sidecar rpaths for dev-mode spawning');
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
  run('cmake', [
    '--build', WHISPER_BUILD_DIR,
    '--target', 'whisper-cli',
    '--target', 'whisper-server',
    '-j',
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status === 0) return;
  const code = result.status ?? result.signal ?? 'unknown';
  console.error(`[fetch-whisper-cli] ${command} failed (${code})`);
  process.exit(1);
}
