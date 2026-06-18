/* SPDX-License-Identifier: Apache-2.0 */

/**
 * electron-builder config — produces Subcast.app / .dmg / .exe artifacts.
 *
 * Decision refs from docs/desktop-packaging.md:
 *   1  app id, 9  mac unsigned, 12 NSIS allow install dir, 24 Win NSIS + selfsign.
 *
 * Why .cjs (not .json5): extraResources globs hard-fail when the source file
 * is missing. Until scripts/fetch-whisper-cli.mjs (Phase 1.8.c) is wired,
 * the whisper-cli binary may not exist locally — we filter the entry at
 * runtime and log a warning so packaging still succeeds for everything else.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;

function osArchTokens() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') {
    return [{ os: 'mac', arch, ext: '' }];
  }
  if (platform === 'win32') {
    return [{ os: 'win', arch, ext: '.exe' }];
  }
  return [{ os: platform, arch, ext: '' }];
}

function buildExtraResources() {
  const out = [];

  // `${ext}` is only expanded by electron-builder in a limited set of
  // patterns — `from:` globs aren't one of them, so we resolve the
  // executable extension at config-load time on the build host. This is
  // fine because we only build the current platform per invocation:
  // pnpm build:desktop:mac runs on macOS, :win runs on Windows.
  const tokens = osArchTokens();

  // Resolve both ffmpeg and ffprobe from their respective installer
  // packages. Each ships per-platform optionalDependencies, so we ask
  // the package for `.path` instead of guessing a glob. Both binaries
  // come pre-signed for arm64 (unlike ffmpeg-static), which is what
  // macOS amfid needs to allow the Electron app to spawn them.
  for (const t of tokens) {
    for (const [pkg, dest] of [
      ['@ffmpeg-installer/ffmpeg', 'ffmpeg'],
      ['@ffprobe-installer/ffprobe', 'ffprobe'],
    ]) {
      let src;
      try {
        const { path: abs } = require(pkg);
        src = path.relative(root, abs);
      } catch {
        src = null;
      }
      if (src && fs.existsSync(path.join(root, src))) {
        out.push({ from: src, to: `${dest}${t.ext}` });
      } else {
        console.warn(`[electron-builder] ${pkg} not resolvable — skipping ${dest} from extraResources.`);
      }
    }

    // whisper-cli: skip the entry entirely if the binary is missing on disk,
    // since the from-glob would fail packaging. The app still launches; only
    // transcription degrades until the binary lands.
    const whisperRel = `binaries/${t.os === 'mac' ? 'darwin' : t.os === 'win' ? 'win32' : t.os}-${t.arch}/whisper-cli${t.ext}`;
    if (fs.existsSync(path.join(root, whisperRel))) {
      out.push({ from: whisperRel, to: `whisper-cli${t.ext}` });
    } else {
      console.warn(`[electron-builder] whisper-cli missing at ${whisperRel} — packaging without it. Run scripts/fetch-whisper-cli.mjs (Phase 1.8.c) before release.`);
    }

    // macOS whisper.cpp dynamic libraries. The upstream CMake build links
    // whisper-cli against @rpath/libwhisper + libggml*.dylib; shipping only
    // the executable leaves dyld looking for the original build directory on
    // tester machines. Keep the dylibs next to whisper-cli and rewrite rpaths
    // in afterPack so the sidecar is self-contained.
    if (t.os === 'mac') {
      const dylibsDir = `binaries/darwin-${t.arch}/whisper-libs`;
      const dylibAbs = path.join(root, dylibsDir);
      if (fs.existsSync(dylibAbs)) {
        out.push({ from: dylibsDir, to: 'whisper-libs' });
      } else {
        console.warn(`[electron-builder] whisper dylibs missing at ${dylibsDir} — whisper-cli may fail to load on another machine.`);
      }
    }

    // llama-server: same missing-file fallback as whisper-cli. Without the
    // binary the AI Insights / 翻译 features fail at first chat() call, but
    // the rest of the app still works — so let packaging continue and warn.
    const llamaRel = `binaries/${t.os === 'mac' ? 'darwin' : t.os === 'win' ? 'win32' : t.os}-${t.arch}/llama-server${t.ext}`;
    if (fs.existsSync(path.join(root, llamaRel))) {
      out.push({ from: llamaRel, to: `llama-server${t.ext}` });
    } else {
      console.warn(`[electron-builder] llama-server missing at ${llamaRel} — packaging without it. Run scripts/fetch-llama-server.mjs.`);
    }
  }

  // Default Whisper model (ggml-base.bin, ~148 MB) — shipped so first
  // launch is offline-usable. Electron main symlinks this into
  // <userData>/models/whisper/ at startup (see desktop/modelManager/
  // seedBundledModel.ts). Missing-file path mirrors the binaries above:
  // packaging still succeeds; the setup wizard just falls back to the
  // download flow.
  const baseModelRel = 'binaries/models/ggml-base.bin';
  if (fs.existsSync(path.join(root, baseModelRel))) {
    out.push({ from: baseModelRel, to: 'models/ggml-base.bin' });
  } else {
    console.warn(`[electron-builder] ${baseModelRel} missing — packaging without bundled base model. Run scripts/fetch-ggml-base.mjs before release.`);
  }

  // Silero VAD model (~1.8 MB) — pre-segments audio so Whisper only
  // sees speech regions. Subcast falls back to fixed-time chunking
  // when the model is missing, so a missing file is recoverable but
  // not desirable. See server/utils/vadSession.ts for resolution.
  const vadRel = 'binaries/models/silero_vad.onnx';
  if (fs.existsSync(path.join(root, vadRel))) {
    out.push({ from: vadRel, to: 'models/silero_vad.onnx' });
  } else {
    console.warn(`[electron-builder] ${vadRel} missing — packaging without Silero VAD. Run scripts/fetch-silero-vad.mjs before release.`);
  }

  // Diarization models (~33 MB combined): pyannote segmentation 3.0
  // (~5.7 MB) + 3D-Speaker campplus speaker embedding (~27 MB) for the
  // v1.5 two-stage pipeline. server/utils/diarize/rawDiarization.ts
  // resolves these via SUBCAST_RESOURCES_PATH/models/diarization/...
  // — without the extraResources entries the desktop build hits the
  // process.cwd() fallback (= '/') and throws assertModelsExist. Same
  // warn-and-continue pattern as the other models above.
  const diarizeModels = [
    ['binaries/models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
     'models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx'],
    ['binaries/models/diarization/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
     'models/diarization/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'],
  ];
  for (const [rel, to] of diarizeModels) {
    if (fs.existsSync(path.join(root, rel))) {
      out.push({ from: rel, to });
    } else {
      console.warn(`[electron-builder] ${rel} missing — packaging without diarize models. Run scripts/fetch-diarize-models.mjs before release.`);
    }
  }

  return out;
}

/** @type {import('electron-builder').Configuration} */
/**
 * Post-pack fixups for sidecar binaries (ffmpeg, whisper-cli) on macOS / Linux:
 *
 *   1. chmod 0755 — ffmpeg-static ships its binary as 0644, which
 *      survives copy and breaks `spawn` with EACCES at runtime.
 *
 *   2. Re-apply ad-hoc codesign on macOS arm64. Apple Silicon enforces
 *      a valid signature on every executable; if the embedded binary
 *      doesn't have one (or its signature got mangled during electron-
 *      builder's packaging step), amfid kills the process at spawn
 *      with exit 137 / "invalid or unsupported format for signature".
 *      `codesign --sign -` applies an ad-hoc signature that the OS
 *      accepts without requiring a developer cert.
 */
async function ensureExecutable(context) {
  if (context.electronPlatformName === 'win32') return;
  const { join } = require('node:path');
  const { chmod, access } = require('node:fs/promises');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);

  const resourcesDir = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');

  for (const name of ['ffmpeg', 'ffprobe', 'whisper-cli', 'llama-server']) {
    const target = join(resourcesDir, name);
    try {
      await access(target);
    } catch {
      continue; // binary skipped by buildExtraResources, nothing to do
    }
    await chmod(target, 0o755);
    if (context.electronPlatformName === 'darwin') {
      // --force overwrites whatever broken signature electron-builder left;
      // --sign - means ad-hoc (no identity required); --deep covers any
      // nested frameworks (ffmpeg-static ships flat so this is mostly
      // defensive).
      try {
        await execFileAsync('codesign', [
          '--force',
          '--deep',
          '--sign', '-',
          target,
        ]);
      } catch (err) {
        // Log but don't fail the build — if codesign isn't available
        // (e.g. CI without Xcode CLT) the .app may still work on the
        // build machine; CI will need Xcode CLT installed.
        console.warn(`[afterPack] codesign ${target} failed:`, err.message);
      }
    }
  }
}

async function fixWhisperDylibs(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { join, basename } = require('node:path');
  const { chmod, access, readdir } = require('node:fs/promises');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);

  const resourcesDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  const whisperCli = join(resourcesDir, 'whisper-cli');
  const libsDir = join(resourcesDir, 'whisper-libs');

  try {
    await access(whisperCli);
    await access(libsDir);
  } catch {
    return;
  }

  let entries;
  try {
    entries = await readdir(libsDir);
  } catch {
    return;
  }
  const dylibs = entries.filter((e) => e.endsWith('.dylib'));
  if (dylibs.length === 0) return;

  async function replaceRpaths(target, desiredRpath) {
    const current = await execFileAsync('otool', ['-l', target]);
    const rpaths = [...current.stdout.matchAll(/path (.+?) \(offset \d+\)/g)]
      .map((m) => m[1]);
    for (const rpath of rpaths) {
      if (rpath === desiredRpath) continue;
      await execFileAsync('install_name_tool', ['-delete_rpath', rpath, target]);
    }
    if (!rpaths.includes(desiredRpath)) {
      await execFileAsync('install_name_tool', ['-add_rpath', desiredRpath, target]);
    }
  }

  async function assertNoBuildMachinePaths(targets) {
    const forbidden = /\/Users\/|node_modules\/nodejs-whisper|Documents\/Code/;
    for (const target of targets) {
      const linked = await execFileAsync('otool', ['-L', target]);
      const loadCommands = await execFileAsync('otool', ['-l', target]);
      const strings = await execFileAsync('strings', [target], { maxBuffer: 64 * 1024 * 1024 });
      const linkedDeps = linked.stdout
        .split('\n')
        .slice(1)
        .join('\n');
      const rpaths = [...loadCommands.stdout.matchAll(/^\s*path (.+?) \(offset \d+\)$/gm)]
        .map((m) => m[1])
        .join('\n');
      const output = `${linkedDeps}\n${rpaths}\n${strings.stdout}`;
      if (forbidden.test(output)) {
        throw new Error(`[afterPack] build-machine path remains in ${target}`);
      }
    }
  }

  await replaceRpaths(whisperCli, '@loader_path/whisper-libs');

  const dylibTargets = [];
  for (const dylib of dylibs) {
    const target = join(libsDir, dylib);
    dylibTargets.push(target);
    await chmod(target, 0o755);
    await replaceRpaths(target, '@loader_path');
    await execFileAsync('install_name_tool', ['-id', `@rpath/${basename(dylib)}`, target]);
    await execFileAsync('codesign', ['--force', '--sign', '-', target]);
  }
  await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', whisperCli]);
  await assertNoBuildMachinePaths([whisperCli, ...dylibTargets]);
}

/**
 * Reclaim ~36 MB by restoring the standard Apple dylib symlink
 * relationship that pnpm install + electron-builder flatten into a
 * duplicate.
 *
 * `libonnxruntime.1.dylib` is supposed to be a symlink to the real
 * `libonnxruntime.1.<minor>.<patch>.dylib`. After pnpm install both
 * exist as full-fat copies (npm pack typically deref-copies symlinks),
 * and electron-builder preserves whatever it finds. The dylib gets
 * dlopen'd via the short name (`@rpath/libonnxruntime.1.dylib`), so a
 * symlink works at runtime exactly the way the upstream layout intends.
 *
 * Idempotent: if the short name is already a symlink (e.g. a future
 * upstream fix lands the relationship correctly), this is a no-op.
 */
async function dedupOnnxruntimeDylib(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { join } = require('node:path');
  const { readdir, lstat, unlink, symlink } = require('node:fs/promises');

  const arch = context.arch === 'x64' || process.arch === 'x64' ? 'x64' : 'arm64';
  const resourcesDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents/Resources/app.asar.unpacked',
  );
  // Both copies of onnxruntime-node need deduping — the top-level one
  // and the Nitro-bundled one under .output/server/node_modules.
  const dirs = [
    join(resourcesDir, 'node_modules/onnxruntime-node/bin/napi-v6/darwin', arch),
    join(resourcesDir, '.output/server/node_modules/onnxruntime-node/bin/napi-v6/darwin', arch),
  ];

  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue; // not present in this copy — skip
    }

    // Match the versioned canonical filename (libonnxruntime.1.26.0.dylib etc.)
    const canonical = entries.find((e) => /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(e));
    const shortName = 'libonnxruntime.1.dylib';
    if (!canonical || !entries.includes(shortName)) continue;
    const shortPath = join(dir, shortName);
    try {
      const st = await lstat(shortPath);
      if (st.isSymbolicLink()) continue; // already done by a prior pack
      await unlink(shortPath);
      await symlink(canonical, shortPath);
      console.log(`[afterPack] dedup onnxruntime dylib: ${shortPath} → ${canonical} (saved ~36 MB)`);
    } catch (err) {
      console.warn(`[afterPack] dedup onnxruntime dylib failed for ${shortPath}:`, err.message);
    }
  }
}

async function fixSherpaOnnxRpaths(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { join } = require('node:path');
  const { access, readdir } = require('node:fs/promises');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);

  const arch = context.arch === 'x64' || process.arch === 'x64' ? 'x64' : 'arm64';
  const resourcesDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
  );
  const platformPackage = `sherpa-onnx-darwin-${arch}`;
  const dirs = [
    join(resourcesDir, '.output', 'server', 'node_modules', platformPackage),
  ];

  for (const dir of dirs) {
    const addon = join(dir, 'sherpa-onnx.node');
    try {
      await access(addon);
    } catch {
      continue;
    }

    let loadCommands;
    try {
      loadCommands = await execFileAsync('otool', ['-l', addon]);
    } catch (err) {
      console.warn(`[afterPack] otool -l ${addon} failed:`, err.message);
      continue;
    }
    const rpaths = [...loadCommands.stdout.matchAll(/^\s*path (.+?) \(offset \d+\)$/gm)]
      .map((m) => m[1]);
    for (const rpath of rpaths) {
      if (rpath === '@loader_path') continue;
      await execFileAsync('install_name_tool', ['-delete_rpath', rpath, addon]);
    }
    if (!rpaths.includes('@loader_path')) {
      await execFileAsync('install_name_tool', ['-add_rpath', '@loader_path', addon]);
    }

    const entries = await readdir(dir);
    const nativeFiles = [addon, ...entries.filter((entry) => entry.endsWith('.dylib')).map((entry) => join(dir, entry))];
    for (const nativeFile of nativeFiles) {
      await execFileAsync('codesign', ['--force', '--sign', '-', nativeFile]);
    }
  }
}

module.exports = {
  appId: 'io.github.twoer.subcast',
  productName: 'Subcast',
  copyright: '© 2026 twoer',
  directories: {
    output: 'dist-electron',
    buildResources: 'assets',
  },

  afterPack: async (context) => {
    await fixWhisperDylibs(context);
    await ensureExecutable(context);
    await dedupOnnxruntimeDylib(context);
    await fixSherpaOnnxRpaths(context);
  },

  // GitHub Releases as the update feed (Phase 4.1). electron-updater
  // looks at this to discover `latest.yml` + the platform artifact.
  publish: [{
    provider: 'github',
    owner: 'twoer',
    repo: 'subcast',
  }],

  files: [
    'desktop-dist/**/*',
    '.output/**/*',
    'package.json',
    // Runtime asset bundle. `directories.buildResources: 'assets'` only
    // exposes things to electron-builder at build time (icon discovery
    // etc.); files the *running* app reads via `join(here, '..', 'assets',
    // ...)` need an explicit `files` entry, otherwise the asar lookup
    // returns an empty NativeImage and macOS shows an invisible tray slot.
    'assets/tray/**',
    '!**/*.{md,map,ts}',
    '!**/{test,tests,__tests__,coverage}/**',

    // Only one targeted exclusion: nodejs-whisper drags in the whole
    // whisper.cpp source tree + any dev-downloaded models — ~1.7 GB
    // of stuff the desktop build doesn't use (it ships a standalone
    // whisper-cli binary via extraResources instead). Every other
    // dep electron-builder figures out from package.json itself.
    '!node_modules/nodejs-whisper/**/*',

    // Diarization loads Nitro's externalized sherpa-onnx-node copy under
    // .output/server/node_modules. Keep Nitro's sibling platform package
    // there because addon-static-import.js first requires
    // `../sherpa-onnx-<platform-arch>/sherpa-onnx.node`.
    // Exclude only the top-level optional package to avoid a duplicate
    // copy outside Nitro's runtime tree.
    '!node_modules/sherpa-onnx-{darwin,linux,win}-{arm64,x64}/**',

    // onnxruntime-node ships pre-built native binaries for every
    // platform (~254 MB combined). For a per-platform dmg/exe we
    // only need the running platform's slice. Build-host's
    // process.platform decides which slices to drop here.
    //
    // Nitro copies onnxruntime-node into `.output/server/node_modules/`
    // as part of its self-contained server bundle, so the same
    // cross-platform exclusion has to be applied there too — otherwise
    // every dmg ships linux + win32 binaries we'll never load.
    ...(process.platform === 'darwin'
      ? [
          '!node_modules/onnxruntime-node/bin/napi-v6/{win32,linux}/**',
          '!.output/server/node_modules/onnxruntime-node/bin/napi-v6/{win32,linux}/**',
        ]
      : process.platform === 'win32'
        ? [
            '!node_modules/onnxruntime-node/bin/napi-v6/{darwin,linux}/**',
            '!.output/server/node_modules/onnxruntime-node/bin/napi-v6/{darwin,linux}/**',
          ]
        : [
            '!node_modules/onnxruntime-node/bin/napi-v6/{darwin,win32}/**',
            '!.output/server/node_modules/onnxruntime-node/bin/napi-v6/{darwin,win32}/**',
          ]),
  ],

  // Native `.node` libraries can't be dlopen'd from inside an asar
  // archive — Electron has to see them as real files on disk.
  // Two copies of each native dep end up in the build:
  //
  //   /node_modules/...                       — top-level pnpm install
  //   /.output/server/node_modules/...        — Nitro's self-contained
  //                                             server bundle (this is
  //                                             the one Nitro actually
  //                                             resolves at runtime)
  //
  // Both must be unpacked or dlopen fails. onnxruntime_binding.node
  // also has an @rpath dep on the sibling libonnxruntime.1.dylib, so
  // extraction to /tmp leaves the dylib behind and dlopen aborts.
  asarUnpack: [
    'node_modules/onnxruntime-node/bin/**',
    '.output/server/node_modules/onnxruntime-node/bin/**',
    'node_modules/better-sqlite3/build/Release/**',
    '.output/server/node_modules/better-sqlite3/build/Release/**',
    // sherpa-onnx-node is externalized into Nitro's .output/server tree,
    // and its platform package must be present as a sibling package for
    // the library's own addon-static-import.js require path.
    '.output/server/node_modules/sherpa-onnx-node/**',
    '.output/server/node_modules/sherpa-onnx-{darwin,linux,win}-{arm64,x64}/**',
  ],

  extraResources: buildExtraResources(),

  fileAssociations: [
    {
      ext: ['mp4', 'mkv', 'mov', 'webm', 'm4a', 'mp3', 'wav'],
      description: 'Media file',
      role: 'Viewer',
    },
  ],

  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    icon: 'assets/icon.icns',
    category: 'public.app-category.productivity',
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },

  dmg: {
    title: 'Subcast ${version}',
    icon: 'assets/icon.icns',
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico',
    // electron-builder 26.x: codesigning moved out of `win.*` —
    // cscLink/cscKeyPassword via env vars (WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD)
    // are read automatically. signtoolOptions holds hashing/timestamp config.
    signtoolOptions: {
      signingHashAlgorithms: ['sha256'],
    },
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // deleteAppDataOnUninstall stays false; build/uninstaller.nsh asks
    // the user explicitly at uninstall time (decision 24).
    deleteAppDataOnUninstall: false,
    include: 'build/uninstaller.nsh',
  },
};
