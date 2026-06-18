/* SPDX-License-Identifier: Apache-2.0 */

/**
 * List the Whisper models currently installed at the canonical
 * `WHISPER_MODELS_DIR` location — i.e. the only place the bundled
 * whisper-cli can actually load from. Distinct from
 * `scanWhisperModels()`, which also surfaces unmanaged copies under
 * Aiko / MacWhisper / etc. for the first-run wizard's "link existing"
 * affordance.
 */

import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { WHISPER_MODEL_NAMES, type WhisperModelName } from '#shared/whisperModels';
import { WHISPER_MODELS_DIR } from './whisperPaths';

// Derived from WHISPER_MODEL_NAMES so adding a new model only touches the
// canonical list — keeps the filename pattern from drifting silently.
const FILENAME_RE = new RegExp(`^ggml-(${WHISPER_MODEL_NAMES.join('|')})\\.bin$`);

type ModelName = WhisperModelName;

/**
 * Minimum expected size per model — files smaller than this are partial
 * downloads (the downloader supports resume, so cancelled tasks leave a
 * stub on disk). Reporting them as "installed" lets the user "switch"
 * to a model that whisper-cli will then fail to load. Numbers are the
 * floor of the published ggerganov/whisper.cpp file sizes minus a small
 * tolerance.
 */
const MIN_BYTES: Record<ModelName, number> = {
  tiny: 70 * 1024 * 1024,
  base: 130 * 1024 * 1024,
  small: 440 * 1024 * 1024,
  medium: 1.4 * 1024 * 1024 * 1024,
  'large-v3': 2.9 * 1024 * 1024 * 1024,
  'large-v3-turbo': 1.5 * 1024 * 1024 * 1024,
};

/**
 * GGML container magic at byte 0. whisper.cpp serializes the magic as a
 * little-endian uint32, so files start with the BYTE REVERSE of the
 * conventional 4-char tag ('ggml' shows up as `6c 6d 67 67` on disk).
 * Comparing as uint32 keeps the table readable and avoids subtle
 * byte-order bugs. Accepted formats:
 *   0x67676d6c — 'ggml' (oldest)
 *   0x67676d66 — 'ggmf' (v1)
 *   0x67676a74 — 'ggjt' (v2/v3, modern ggerganov shipments)
 */
const GGML_MAGICS_LE: ReadonlySet<number> = new Set([0x67676d6c, 0x67676d66, 0x67676a74]);

async function readMagicU32LE(path: string): Promise<number | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return null;
    return buf.readUInt32LE(0);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export interface InstalledWhisperModel {
  name: ModelName;
  path: string;
  sizeBytes: number;
}

/**
 * Same two-layer validation `listInstalledWhisperModels` does, scoped to
 * one model name. Returns true iff a file at the canonical path is
 * larger than the per-model floor AND starts with a known GGML magic.
 * Cheap (size stat + 4-byte read).
 *
 * Used by the transcribe entry points to refuse jobs whose target
 * model isn't actually usable — settings may point to a partially-
 * downloaded or never-installed model.
 */
export async function isWhisperModelReady(name: string): Promise<boolean> {
  if (!(name in MIN_BYTES)) return false;
  const min = MIN_BYTES[name as ModelName];
  const filePath = join(WHISPER_MODELS_DIR, `ggml-${name}.bin`);
  try {
    const st = await stat(filePath);
    if (!st.isFile() || st.size < min) return false;
  } catch {
    return false;
  }
  const magic = await readMagicU32LE(filePath);
  return magic !== null && GGML_MAGICS_LE.has(magic);
}

export async function listInstalledWhisperModels(): Promise<InstalledWhisperModel[]> {
  let entries: string[];
  try {
    entries = await readdir(WHISPER_MODELS_DIR);
  } catch {
    return [];
  }

  const results: InstalledWhisperModel[] = [];
  for (const entry of entries) {
    const m = FILENAME_RE.exec(entry);
    if (!m) continue;
    const name = m[1] as ModelName;
    const filePath = join(WHISPER_MODELS_DIR, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      // Skip partial downloads — the stub on disk isn't loadable by
      // whisper-cli. The wizard's "Download more" flow will resume from
      // the stub on the next attempt; until then, hide it from the
      // installed list so users can't accidentally switch to it.
      if (st.size < MIN_BYTES[name]) continue;
      // Magic sniff: a file that doesn't start with a known GGML
      // container header isn't a valid whisper model even if the size
      // and filename happen to match. Cheap — 4 bytes per file.
      const magic = await readMagicU32LE(filePath);
      if (magic === null || !GGML_MAGICS_LE.has(magic)) continue;
      results.push({ name, path: filePath, sizeBytes: st.size });
    } catch {
      /* missing file race — skip */
    }
  }
  return results.sort((a, b) => a.sizeBytes - b.sizeBytes);
}
