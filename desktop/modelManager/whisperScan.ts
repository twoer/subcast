/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Scan well-known filesystem locations for an already-downloaded
 * `ggml-*.bin` Whisper model so the setup wizard can offer "symlink" /
 * "copy" instead of re-downloading 1.5 GB (§ 5.7, decision 34).
 *
 * The scanner is filename-driven (cheap) with optional SHA256 verification
 * (slow, gated by `verifyHashes`). Plausible sources we know about:
 *
 *   - Subcast's own web-version data dir
 *   - User-compiled whisper.cpp under ~/whisper.cpp/models/
 *   - macOS shells (Aiko / Whisper Transcription / MacWhisper)
 *   - User-supplied extra paths
 *
 * Files that don't match the expected size for their declared model are
 * dropped (most likely truncated downloads). Files that match by name and
 * size but fail hash verification (when enabled) are marked
 * `verified: false` so the UI can warn the user.
 */

import { createHash } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

// Curated subset of the canonical model list — the setup wizard
// intentionally excludes 'large-v3' in favour of 'large-v3-turbo' as
// the high-end pick. Using Extract keeps this subset tied to the
// shared source of truth: adding a new model upstream forces a
// decision here (compile error until included or excluded).
import type { WhisperModelName as CanonicalWhisperModelName } from '#shared/whisperModels';
export type WhisperModelName = Extract<
  CanonicalWhisperModelName,
  'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo'
>;

export interface ModelMeta {
  /** Lower-bound size in bytes — files smaller than this are rejected. */
  minBytes: number;
  /** Upper-bound size — guards against impostor large files. */
  maxBytes: number;
  /** Known SHA256 (lowercase hex). Populated from upstream when available. */
  sha256?: string;
}

/**
 * Size ranges drawn from the published ggerganov/whisper.cpp files.
 * Hashes are intentionally left empty — populate from upstream as part of
 * a release-time data refresh. Scanning works without them; only the
 * `verified` field reflects their absence.
 */
export const MODEL_META: Record<WhisperModelName, ModelMeta> = {
  tiny: { minBytes: 70 * 1024 * 1024, maxBytes: 90 * 1024 * 1024 },
  base: { minBytes: 130 * 1024 * 1024, maxBytes: 170 * 1024 * 1024 },
  small: { minBytes: 440 * 1024 * 1024, maxBytes: 500 * 1024 * 1024 },
  medium: { minBytes: 1.4 * 1024 * 1024 * 1024, maxBytes: 1.6 * 1024 * 1024 * 1024 },
  'large-v3-turbo': { minBytes: 1.5 * 1024 * 1024 * 1024, maxBytes: 1.7 * 1024 * 1024 * 1024 },
};

export interface ScanResult {
  name: WhisperModelName;
  path: string;
  /** Short human-readable label of where it was found. */
  source: string;
  sizeBytes: number;
  /**
   * `true` only when a SHA256 was both known and matched. `false` if a
   * known hash mismatched. `null` if we didn't have a hash to compare
   * against (the default — saves a multi-GB read).
   */
  verified: boolean | null;
}

export interface ScanOptions {
  /** Additional directories supplied by the user. */
  extraPaths?: string[];
  /** Run SHA256 against MODEL_META hashes. Defaults to false. */
  verifyHashes?: boolean;
  /** Override the default scan roots — primarily for tests. */
  rootPaths?: string[];
}

const FILENAME_RE = /^ggml-(tiny|base|small|medium|large-v3-turbo)(?:\.bin|\.en\.bin)?$/;

function isWhisperModelName(s: string): s is WhisperModelName {
  return s in MODEL_META;
}

/**
 * Built once per call so tests can pass fake values via env. The list
 * mixes "package-managed" install locations (Aiko / MacWhisper) with
 * common dev-tree paths where nodejs-whisper drops models when Subcast
 * is run from source. Anything pnpm-installed lives under a project
 * `node_modules/`, which Spotlight skips by default — so a passive scan
 * needs to enumerate likely parent dirs.
 */
function defaultRoots(): Array<{ path: string; source: string }> {
  const home = homedir();
  const roots: Array<{ path: string; source: string }> = [];

  // Canonical install location FIRST so already-installed models surface
  // with a known `source` and the setup-status endpoint can flag them
  // as installed. SUBCAST_HOME is set by Electron main to
  // app.getPath('userData') before Nitro starts; absent in web mode.
  const subcastHome = process.env.SUBCAST_HOME;
  if (subcastHome) {
    roots.push({
      path: join(subcastHome, 'models', 'whisper'),
      source: 'Subcast',
    });
  }

  // Packaged-app userData paths per platform — Electron resolves
  // app.getPath('userData') to these. Including them here lets the
  // `dev:desktop:hot` orchestrator (which uses its own .dev-userdata as
  // SUBCAST_HOME) still surface models the user already downloaded via
  // the packaged Subcast — they show up as a "Subcast (installed)"
  // source the wizard can symlink/copy into the dev dir.
  if (process.platform === 'darwin') {
    roots.push({
      path: join(home, 'Library', 'Application Support', 'Subcast', 'models', 'whisper'),
      source: 'Subcast (installed)',
    });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      roots.push({
        path: join(appData, 'Subcast', 'models', 'whisper'),
        source: 'Subcast (installed)',
      });
    }
  } else {
    // Linux follows XDG; Electron defaults to ~/.config/<productName>.
    roots.push({
      path: join(home, '.config', 'Subcast', 'models', 'whisper'),
      source: 'Subcast (installed)',
    });
  }

  roots.push(
    // The web-mode design used `~/.subcast/...`; kept for back-compat but
    // the real-world location for someone running Subcast from source
    // is `<project>/node_modules/nodejs-whisper/cpp/whisper.cpp/models`.
    {
      path: join(home, '.subcast', 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'models'),
      source: 'Subcast (web)',
    },
    { path: join(home, 'whisper.cpp', 'models'), source: 'whisper.cpp' },
    { path: join(home, 'Library', 'Application Support', 'com.aiko.app', 'models'), source: 'Aiko' },
    {
      path: join(home, 'Library', 'Containers', 'com.subblack.MacWhisper', 'Data', 'Library', 'Application Support', 'MacWhisper', 'models'),
      source: 'MacWhisper',
    },
  );

  // Probe a shallow set of dev-tree parents for a `subcast` checkout
  // (the source-clone case). We only descend a level or two so a 200K
  // node_modules tree doesn't get walked here.
  const devParents = [
    join(home, 'Documents', 'Code'),
    join(home, 'Documents'),
    join(home, 'Code'),
    join(home, 'Projects'),
    join(home, 'projects'),
    join(home, 'dev'),
    join(home, 'workspace'),
  ];
  for (const parent of devParents) {
    // Two common layouts: `<parent>/subcast/...` and `<parent>/<group>/subcast/...`
    // (matches the `Documents/Code/my-2026/subcast` style this repo lives in).
    const candidates = [
      ['subcast', 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'models'],
      ['*/subcast', 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp', 'models'],
    ];
    for (const parts of candidates) {
      // Expand the glob lazily — only when the parent dir exists at all.
      const probe = join(parent, parts[0]!);
      if (parts[0]!.includes('*')) {
        // Glob the wildcard segment by listing children of `parent`
        // and trying each. Keeps things bounded.
        let entries: string[] = [];
        try {
          // readdirSync to keep this function pure-sync at the call site.
          // Failures (missing parent dir) yield empty list.
          entries = readdirSync(parent);
        } catch {
          continue;
        }
        for (const child of entries) {
          roots.push({
            path: join(parent, child, ...parts.slice(1)),
            source: `Subcast source · ${child}`,
          });
        }
      } else {
        roots.push({ path: probe, source: 'Subcast source' });
      }
    }
  }

  return roots;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function scanWhisperModels(options: ScanOptions = {}): Promise<ScanResult[]> {
  const roots =
    options.rootPaths !== undefined
      ? options.rootPaths.map((p) => ({ path: p, source: p }))
      : defaultRoots();
  const extras = (options.extraPaths ?? []).map((p) => ({ path: p, source: 'User' }));

  const results: ScanResult[] = [];
  const seenPaths = new Set<string>();

  for (const root of [...roots, ...extras]) {
    const entries = await safeReaddir(root.path);
    for (const entry of entries) {
      const match = FILENAME_RE.exec(entry);
      if (!match) continue;

      const rawName = match[1]!;
      if (!isWhisperModelName(rawName)) continue;
      const name = rawName;

      const fullPath = join(root.path, entry);
      if (seenPaths.has(fullPath)) continue;
      seenPaths.add(fullPath);

      let sizeBytes: number;
      try {
        const st = await stat(fullPath);
        if (!st.isFile()) continue;
        sizeBytes = st.size;
      } catch {
        continue;
      }

      const meta = MODEL_META[name];
      if (sizeBytes < meta.minBytes || sizeBytes > meta.maxBytes) continue;

      let verified: boolean | null = null;
      if (options.verifyHashes && meta.sha256) {
        try {
          verified = (await sha256OfFile(fullPath)) === meta.sha256;
        } catch {
          verified = false;
        }
      }

      results.push({ name, path: fullPath, source: root.source, sizeBytes, verified });
    }
  }

  return results;
}
