/* SPDX-License-Identifier: AGPL-3.0-or-later */

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

module.exports = {
  appId: 'io.github.twoer.subcast',
  productName: 'Subcast',
  copyright: '© 2026 twoer',
  directories: {
    output: 'dist-electron',
    buildResources: 'assets',
  },

  afterPack: ensureExecutable,

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
    '!**/*.{md,map,ts}',
    '!**/{test,tests,__tests__,coverage}/**',

    // Only one targeted exclusion: nodejs-whisper drags in the whole
    // whisper.cpp source tree + any dev-downloaded models — ~1.7 GB
    // of stuff the desktop build doesn't use (it ships a standalone
    // whisper-cli binary via extraResources instead). Every other
    // dep electron-builder figures out from package.json itself.
    '!node_modules/nodejs-whisper/**/*',
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
