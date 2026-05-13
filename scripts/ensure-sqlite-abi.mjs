#!/usr/bin/env node
/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Ensure better-sqlite3's native binary matches the requested Node ABI.
 *
 * Why this exists: the project alternates between two Node ABIs.
 *   - Vitest / typecheck / general scripts run under the system Node
 *     (e.g. v22 → ABI 127).
 *   - Electron 36 ships its own Node fork at ABI 135.
 *
 * Switching contexts without rebuilding triggers ERR_DLOPEN_FAILED with
 * a cryptic "compiled against a different Node.js version" message that
 * costs every new contributor 15-30 minutes the first time they hit it.
 * This script is idempotent (skip if already correct) and fast (<200ms
 * when no rebuild is needed), so it can be a pretest / predev hook
 * without slowing the inner loop.
 *
 * Usage:
 *   node scripts/ensure-sqlite-abi.mjs node       # rebuild for Node ABI
 *   node scripts/ensure-sqlite-abi.mjs electron   # rebuild for Electron ABI
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const TARGET = process.argv[2];
if (TARGET !== 'node' && TARGET !== 'electron') {
  console.error('Usage: ensure-sqlite-abi.mjs <node|electron>');
  process.exit(1);
}

const REPO = process.cwd();

// pnpm hoists better-sqlite3 under .pnpm/<pkg>/...; the build artifacts
// live under build/Release. We track the last-built ABI via .forge-meta
// (electron-rebuild writes it; `pnpm rebuild` doesn't, so we maintain
// it ourselves at the end of this script).
const META_PATH = join(
  REPO,
  'node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/.forge-meta',
);

// Electron major version → Node ABI (NODE_MODULE_VERSION). The mapping
// is stable per Electron major and rarely changes; bump on Electron
// upgrade. Reference: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
//
// Why a table and not `electron --abi`: Electron has no such CLI flag.
// Passing `--abi` to the binary makes it interpret the string as an
// app path, which fails to resolve and shows the default-app welcome
// window indefinitely — hanging any blocking spawn that's waiting on
// it. (Lesson learned the hard way.)
const ABI_BY_ELECTRON_MAJOR = {
  32: '131',
  33: '131',
  34: '133',
  35: '133',
  36: '135',
  37: '137',
};

function currentNodeAbi() {
  return String(process.versions.modules);
}

function electronAbi() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(REPO, 'node_modules/electron/package.json'), 'utf8'),
    );
    const major = Number.parseInt(String(pkg.version).split('.')[0], 10);
    const abi = ABI_BY_ELECTRON_MAJOR[major];
    if (abi) return abi;
    console.warn(
      `[ensure-abi] unknown Electron major ${major}; falling back to 135. ` +
      'Update ABI_BY_ELECTRON_MAJOR in scripts/ensure-sqlite-abi.mjs.',
    );
    return '135';
  } catch (err) {
    console.warn(
      `[ensure-abi] could not read electron/package.json (${err.message}); ` +
      'falling back to ABI 135',
    );
    return '135';
  }
}

function currentBinaryAbi() {
  if (!existsSync(META_PATH)) return null;
  const meta = readFileSync(META_PATH, 'utf8').trim();
  const m = /--(\d+)/.exec(meta);
  return m ? m[1] : null;
}

const targetAbi = TARGET === 'electron' ? electronAbi() : currentNodeAbi();
const have = currentBinaryAbi();

if (have === targetAbi) {
  console.log(
    `[ensure-abi] better-sqlite3 already built for ABI ${targetAbi} (${TARGET}); skipping.`,
  );
  process.exit(0);
}

console.log(
  `[ensure-abi] rebuilding better-sqlite3 for ABI ${targetAbi} (${TARGET}); was ${have ?? 'unknown'}.`,
);

// `pnpm exec electron-rebuild` is what the existing release / hot
// scripts use, so we go through the same entry point to keep behavior
// identical. The system Node path uses `pnpm rebuild`, which runs the
// package's install scripts and produces a binary against the current
// Node ABI.
const cmd =
  TARGET === 'electron'
    ? 'pnpm exec electron-rebuild -f -w better-sqlite3'
    : 'pnpm rebuild better-sqlite3';

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error(`[ensure-abi] rebuild failed: ${err.message}`);
  process.exit(1);
}

// `pnpm rebuild` doesn't maintain .forge-meta — write our own marker so
// the next invocation can shortcut whichever path it's on. Best-effort:
// if the write fails, bindings still loads correctly, we just lose the
// fast-path on the next run.
try {
  await writeFile(META_PATH, `${process.arch}--${targetAbi}`);
} catch {
  // non-fatal
}
