#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

import { accessSync, constants, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import packageJson from '../package.json' with { type: 'json' };

const root = process.cwd();
const appPath = process.argv[2] ?? join(root, 'dist-electron', 'mac-arm64', 'Subcast.app');
const resourcesDir = join(appPath, 'Contents', 'Resources');
const expectedVersion = packageJson.version;
const forbiddenBuildPath = /\/Users\/|Documents\/Code|node_modules\/nodejs-whisper|whisper\.cpp\/build/;

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`[verify-mac-artifact] FAIL ${message}`);
}

function pass(message) {
  console.log(`[verify-mac-artifact] OK ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return result;
}

function requireTool(name) {
  const result = run('xcrun', ['-find', name]);
  if (result.status !== 0) {
    fail(`${name} not found via xcrun`);
    return false;
  }
  pass(`${name} available`);
  return true;
}

function checkExecutable(path, label) {
  if (!existsSync(path)) {
    fail(`${label} missing at ${path}`);
    return;
  }
  try {
    accessSync(path, constants.X_OK);
    pass(`${label} is executable`);
  } catch {
    fail(`${label} is not executable: ${path}`);
  }
}

function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function parseRpaths(machoPath) {
  const result = run('otool', ['-l', machoPath]);
  if (result.status !== 0) {
    fail(`otool -l failed for ${machoPath}: ${output(result).trim()}`);
    return [];
  }
  return [...result.stdout.matchAll(/^\s*path (.+?) \(offset \d+\)$/gm)].map((m) => m[1]);
}

function checkNoBuildPaths(machoPath, options = {}) {
  const allowDebugStrings = options.allowDebugStrings === true;
  const linked = run('otool', ['-L', machoPath]);
  const loadCommands = run('otool', ['-l', machoPath]);
  const strings = run('strings', [machoPath]);
  if (linked.status !== 0) {
    fail(`otool -L failed for ${machoPath}: ${output(linked).trim()}`);
  } else {
    const linkedDeps = linked.stdout.split('\n').slice(1).join('\n');
    if (forbiddenBuildPath.test(linkedDeps)) {
      fail(`otool -L found build-machine path in ${machoPath}`);
    }
  }
  if (loadCommands.status !== 0) {
    fail(`otool -l failed for ${machoPath}: ${output(loadCommands).trim()}`);
  } else {
    const rpaths = [...loadCommands.stdout.matchAll(/^\s*path (.+?) \(offset \d+\)$/gm)]
      .map((m) => m[1])
      .join('\n');
    if (forbiddenBuildPath.test(rpaths)) {
      fail(`otool -l found build-machine rpath in ${machoPath}`);
    }
  }
  if (strings.status !== 0) {
    fail(`strings failed for ${machoPath}: ${output(strings).trim()}`);
  } else if (!allowDebugStrings && forbiddenBuildPath.test(strings.stdout)) {
    fail(`strings found build-machine path in ${machoPath}`);
  }
}

function checkLoadCommands(machoPath) {
  const linked = run('otool', ['-L', machoPath]);
  if (linked.status !== 0) {
    fail(`otool -L failed for ${machoPath}: ${output(linked).trim()}`);
    return;
  }
  const linkedDeps = linked.stdout.split('\n').slice(1).join('\n');
  if (forbiddenBuildPath.test(linkedDeps)) {
    fail(`otool -L found build-machine path in ${machoPath}`);
  }
}

function checkWhisperMachO(machoPath, expectedRpath) {
  checkExecutable(machoPath, machoPath.includes('whisper-cli') ? 'whisper-cli' : machoPath);
  checkLoadCommands(machoPath);

  const rpaths = parseRpaths(machoPath);
  if (!rpaths.includes(expectedRpath)) {
    fail(`${machoPath} missing rpath ${expectedRpath}; got ${rpaths.join(', ') || '<none>'}`);
  } else {
    pass(`${machoPath} rpath includes ${expectedRpath}`);
  }
  const badRpath = rpaths.find((rpath) => rpath !== expectedRpath);
  if (badRpath) {
    fail(`${machoPath} has unexpected rpath ${badRpath}`);
  }
  checkNoBuildPaths(machoPath);
}

function checkNativeFile(path, label, options = {}) {
  if (!existsSync(path)) {
    fail(`${label} missing at ${path}`);
    return false;
  }
  pass(`${label} exists`);
  checkLoadCommands(path);
  checkNoBuildPaths(path, options);
  return true;
}

function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(16);
  readSync(fd, sizeBuf, 0, 16, 0);
  const headerStringSize = sizeBuf.readUInt32LE(12);
  const headerBuf = Buffer.alloc(headerStringSize);
  readSync(fd, headerBuf, 0, headerStringSize, 16);
  return JSON.parse(headerBuf.toString('utf8'));
}

function asarHasPath(header, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) return false;
  }
  return true;
}

function checkAsarPath(relPath) {
  const asarPath = join(resourcesDir, 'app.asar');
  if (!existsSync(asarPath)) {
    fail(`cannot inspect missing app.asar for ${relPath}`);
    return;
  }
  try {
    const header = readAsarHeader(asarPath);
    if (asarHasPath(header, relPath)) {
      pass(`app.asar contains ${relPath}`);
    } else {
      fail(`app.asar missing ${relPath}; require() cannot resolve its unpacked twin`);
    }
  } catch (err) {
    fail(`failed to inspect app.asar for ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (process.platform !== 'darwin') {
  fail(`mac artifact verification must run on macOS; got ${process.platform}`);
}

requireTool('otool');
requireTool('strings');

if (!existsSync(appPath)) {
  fail(`Subcast.app missing at ${appPath}`);
} else {
  pass(`Subcast.app exists at ${appPath}`);
}

const dmgPath = join(root, 'dist-electron', `Subcast-${expectedVersion}-arm64.dmg`);
if (!existsSync(dmgPath)) {
  fail(`DMG missing at ${dmgPath}`);
} else {
  const size = statSync(dmgPath).size;
  if (size < 1024 * 1024) {
    fail(`DMG looks too small: ${size} bytes`);
  } else {
    pass(`DMG exists (${Math.round(size / 1024 / 1024)} MB)`);
  }
}

const info = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents', 'Info.plist')]);
if (info.status !== 0) {
  fail(`failed to read app version: ${output(info).trim()}`);
} else if (info.stdout.trim() !== expectedVersion) {
  fail(`app version mismatch: expected ${expectedVersion}, got ${info.stdout.trim()}`);
} else {
  pass(`app version is ${expectedVersion}`);
}

for (const name of ['app.asar', 'ffmpeg', 'ffprobe', 'whisper-cli']) {
  const path = join(resourcesDir, name);
  if (!existsSync(path)) {
    fail(`${name} missing in Resources`);
  } else {
    pass(`${name} exists in Resources`);
  }
}

const requiredModels = [
  ['Whisper base model', 'models/ggml-base.bin', 130 * 1024 * 1024],
  [
    'diarize segmentation model',
    'models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
    5 * 1024 * 1024,
  ],
  [
    'diarize embedding model',
    'models/diarization/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
    25 * 1024 * 1024,
  ],
];
for (const [label, rel, minBytes] of requiredModels) {
  const modelPath = join(resourcesDir, rel);
  if (!existsSync(modelPath)) {
    fail(`${label} missing at Resources/${rel}`);
    continue;
  }
  const size = statSync(modelPath).size;
  if (size < minBytes) {
    fail(`${label} too small: ${size} bytes`);
  } else {
    pass(`${label} exists (${Math.round(size / 1024 / 1024)} MB)`);
  }
}

for (const name of ['ffmpeg', 'ffprobe', 'whisper-cli']) {
  checkExecutable(join(resourcesDir, name), name);
}

const whisperCli = join(resourcesDir, 'whisper-cli');
if (existsSync(whisperCli)) {
  const help = run(whisperCli, ['--help']);
  if (help.status === 0) {
    pass('whisper-cli --help exits 0');
  } else {
    fail(`whisper-cli --help failed (${help.status ?? help.signal}): ${output(help).trim()}`);
  }
  checkWhisperMachO(whisperCli, '@loader_path/whisper-libs');
}

const libsDir = join(resourcesDir, 'whisper-libs');
if (!existsSync(libsDir)) {
  fail(`whisper-libs missing at ${libsDir}`);
} else {
  const dylibs = readdirSync(libsDir)
    .filter((entry) => /^lib(?:whisper|ggml).*\.dylib$/.test(entry))
    .sort();
  if (dylibs.length === 0) {
    fail('no whisper dylibs found in whisper-libs');
  } else {
    pass(`found ${dylibs.length} whisper dylib(s)`);
  }
  for (const dylib of dylibs) {
    checkWhisperMachO(join(libsDir, dylib), '@loader_path');
  }
}

function checkSherpaPackage(sherpaDir, label) {
  const sherpaNode = join(sherpaDir, 'sherpa-onnx.node');
  if (!checkNativeFile(sherpaNode, `${label}/sherpa-onnx.node`)) return;
  const sherpaDylibs = readdirSync(sherpaDir)
    .filter((entry) => entry.endsWith('.dylib'))
    .sort();
  if (sherpaDylibs.length === 0) {
    fail(`no dylibs found in ${sherpaDir}`);
  } else {
    pass(`found ${sherpaDylibs.length} sherpa dylib(s) in ${label}`);
  }
  for (const dylib of sherpaDylibs) {
    checkNativeFile(join(sherpaDir, dylib), `${label}/${dylib}`, { allowDebugStrings: true });
  }
}

const sherpaPackage = `sherpa-onnx-darwin-${process.arch}`;
checkAsarPath(`.output/server/node_modules/${sherpaPackage}/sherpa-onnx.node`);
checkSherpaPackage(
  join(resourcesDir, 'app.asar.unpacked', '.output', 'server', 'node_modules', sherpaPackage),
  `.output/server/node_modules/${sherpaPackage}`,
);

if (failures.length > 0) {
  console.error(`[verify-mac-artifact] ${failures.length} check(s) failed`);
  process.exit(1);
}

console.log('[verify-mac-artifact] all checks passed');
