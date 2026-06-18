/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Scan well-known filesystem locations for an already-downloaded Qwen 2.5
 * Instruct GGUF so the setup wizard can offer "symlink" / "copy" instead of
 * re-downloading several GB. Mirrors `whisperScan.ts` — same `ScanResult`
 * shape, same `defaultRoots()` + safe-readdir style, just different roots
 * (LM Studio, Jan, llama.cpp cache) and a different filename regex.
 *
 * Layouts we account for:
 *   - `~/.cache/lm-studio/models/lmstudio-community/Qwen2.5-7B-Instruct-GGUF/<file>.gguf`
 *   - `~/Library/Caches/jan/models/<repo>/<file>.gguf`
 *   - `~/.cache/llama.cpp/<file>.gguf`
 *   - Subcast's own canonical install dir
 *
 * Nested layouts (LM Studio in particular) need a recursive walk; we cap
 * depth at 4 to keep things bounded.
 */

import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { LlmModelId } from './llmConfig';
import { LLM_MODELS } from './llmConfig';

const FILENAME_RE = /^Qwen2\.5-(3B|7B|14B)-Instruct-Q4_K_M\.gguf$/i;

export interface LlmScanResult {
  name: LlmModelId;
  path: string;
  source: string;
  sizeBytes: number;
}

export interface LlmScanOptions {
  /** Additional directories supplied by the user. */
  extraPaths?: string[];
  /** Override the default scan roots — primarily for tests. */
  rootPaths?: string[];
  /** Test seam: lower the minimum size for synthetic GGUFs. */
  minSizeOverride?: number;
}

function defaultRoots(): Array<{ path: string; source: string }> {
  const home = homedir();
  const roots: Array<{ path: string; source: string }> = [];

  // Canonical install location FIRST so already-installed models surface
  // with a known `source` and the setup-status endpoint can flag them
  // as installed. SUBCAST_HOME is set by Electron main to
  // app.getPath('userData') before Nitro starts; absent in web mode.
  const subcastHome = process.env.SUBCAST_HOME;
  if (subcastHome) {
    roots.push({ path: join(subcastHome, 'models', 'llm'), source: 'Subcast' });
  }

  // Packaged-app userData path on macOS — when running dev-hot against
  // a separate SUBCAST_HOME, this surfaces models the user already
  // downloaded via the packaged build.
  if (process.platform === 'darwin') {
    roots.push({
      path: join(home, 'Library', 'Application Support', 'Subcast', 'models', 'llm'),
      source: 'Subcast (installed)',
    });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      roots.push({
        path: join(appData, 'Subcast', 'models', 'llm'),
        source: 'Subcast (installed)',
      });
    }
  } else {
    roots.push({
      path: join(home, '.config', 'Subcast', 'models', 'llm'),
      source: 'Subcast (installed)',
    });
  }

  roots.push(
    { path: join(home, '.cache', 'lm-studio', 'models', 'lmstudio-community'), source: 'LM Studio' },
    { path: join(home, '.cache', 'llama.cpp'), source: 'llama.cpp cache' },
    { path: join(home, 'Library', 'Caches', 'jan', 'models'), source: 'Jan' },
    { path: join(home, 'Library', 'Application Support', 'jan', 'data', 'models'), source: 'Jan' },
    { path: join(home, '.subcast', 'models', 'llm'), source: 'Subcast (legacy)' },
  );
  return roots;
}

async function safeReaddirRecursive(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await safeReaddirRecursive(full, depth - 1)));
    } else if (e.isFile() && FILENAME_RE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function asModelId(s: string): LlmModelId | null {
  const lower = s.toLowerCase();
  if (lower === '3b' || lower === '7b' || lower === '14b') return lower;
  return null;
}

export async function scanLlmModels(opts: LlmScanOptions = {}): Promise<LlmScanResult[]> {
  const roots = opts.rootPaths
    ? opts.rootPaths.map((p) => ({ path: p, source: p }))
    : defaultRoots();
  const extras = (opts.extraPaths ?? []).map((p) => ({ path: p, source: 'User' }));
  // When tests pass minSizeOverride they explicitly opt out of catalog-based
  // size sanity (synthetic GGUFs are tiny). In production we use the per-model
  // ±30% window, which doubles as both a floor (truncated downloads) and a
  // ceiling (impostor files).
  const overrideMinSize = opts.minSizeOverride;
  const useCatalogSizeCheck = overrideMinSize === undefined;
  const minSize = overrideMinSize ?? 0;

  const results: LlmScanResult[] = [];
  const seen = new Set<string>();

  for (const root of [...roots, ...extras]) {
    const files = await safeReaddirRecursive(root.path, 4);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      let size: number;
      try {
        const st = await stat(file);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      if (size < minSize) continue;
      const m = FILENAME_RE.exec(basename(file));
      const id = m ? asModelId(m[1]!) : null;
      if (!id) continue;
      if (useCatalogSizeCheck) {
        const expected = LLM_MODELS[id].sizeBytes;
        if (size < expected * 0.7 || size > expected * 1.3) continue;
      }
      results.push({ name: id, path: file, source: root.source, sizeBytes: size });
    }
  }
  return results;
}
