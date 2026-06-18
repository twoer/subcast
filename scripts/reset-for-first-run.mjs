#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Reset Subcast (and optionally Ollama) to a first-run-like state.
 *
 * Use cases:
 *   - Verify the setup wizard end-to-end without re-installing the app
 *   - Reproduce a "fresh install" bug report
 *   - Wipe accumulated transcription cache / DB during dev
 *
 * SAFETY: This script is destructive but DEFAULTS TO DRY-RUN. Nothing
 * is deleted until you pass `--yes`. Run without flags first to see
 * exactly what would go.
 *
 * Usage:
 *   node scripts/reset-for-first-run.mjs                       # dry-run, scope=wizard
 *   node scripts/reset-for-first-run.mjs --scope=wizard --yes  # apply
 *   node scripts/reset-for-first-run.mjs --scope=clean --yes   # + uninstall Ollama app
 *   node scripts/reset-for-first-run.mjs --backup              # also tar Subcast data to ~/Desktop
 *
 * Scopes:
 *   wizard (default)
 *     • wipe Subcast userData (DB, cache, logs, downloaded models,
 *       videos, window state)
 *     • `ollama rm qwen2.5:14b` (keeps Ollama installed + running)
 *     • wipe repo-local `.dev-userdata/` if it exists
 *     → boots into setup wizard with Ollama detected as "running"
 *       but the LLM model missing.
 *
 *   models
 *     • everything in `wizard` + remove ALL Ollama-installed models
 *       (not Ollama itself).
 *
 *   clean
 *     • everything in `models` + uninstall the Ollama application
 *       and remove ~/.ollama. Step 2 of the wizard will show
 *       "needs-install".
 *
 *   subcast-only
 *     • just wipe Subcast userData + dev userdata. Don't touch Ollama
 *       at all (use this if you only want to test Whisper-side flows).
 */

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, basename } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import process from 'node:process';

// ── flag parsing ────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
let scope = 'wizard';
for (const a of args) {
  if (a.startsWith('--scope=')) scope = a.slice('--scope='.length);
}
const DRY = !args.has('--yes');
const BACKUP = args.has('--backup');

const VALID_SCOPES = new Set(['wizard', 'models', 'clean', 'subcast-only']);
if (!VALID_SCOPES.has(scope)) {
  console.error(`Unknown --scope=${scope}. Valid: ${[...VALID_SCOPES].join(' | ')}`);
  process.exit(1);
}

// ── platform paths ──────────────────────────────────────────────────
const HOME = homedir();
const OS = platform();

function subcastUserData() {
  if (OS === 'darwin') return join(HOME, 'Library', 'Application Support', 'Subcast');
  if (OS === 'win32') {
    const appData = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');
    return join(appData, 'Subcast');
  }
  // Linux / others — Electron defaults to XDG_CONFIG_HOME or ~/.config
  return join(HOME, '.config', 'Subcast');
}

const SUBCAST_USER_DATA = subcastUserData();
const DEV_USERDATA = join(process.cwd(), '.dev-userdata');
const OLLAMA_DIR = join(HOME, '.ollama');
const OLLAMA_APP = OS === 'darwin' ? '/Applications/Ollama.app' : null;

// ── sizing helpers ──────────────────────────────────────────────────
function dirSize(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      let entries;
      try { entries = readdirSync(p); } catch { continue; }
      for (const e of entries) stack.push(join(p, e));
    } else {
      total += st.size;
    }
  }
  return total;
}

function humanSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function listIfExists(path) {
  if (!existsSync(path)) return null;
  return {
    path,
    size: dirSize(path),
    children: (() => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    })(),
  };
}

// ── plan: what to remove for the chosen scope ───────────────────────
const plan = {
  paths: [],          // filesystem paths to rm -rf
  commands: [],       // shell commands to run (ollama rm, etc.)
  notes: [],          // human-readable side effects
};

// All scopes wipe Subcast's userData and the dev userdata.
plan.paths.push(SUBCAST_USER_DATA);
if (existsSync(DEV_USERDATA)) plan.paths.push(DEV_USERDATA);

if (scope === 'wizard') {
  plan.commands.push('ollama rm qwen2.5:14b');
  plan.notes.push('Ollama stays installed and running.');
} else if (scope === 'models') {
  plan.commands.push('ollama list  → ollama rm <each>');
  plan.notes.push('Ollama stays installed; only its model store is emptied.');
} else if (scope === 'clean') {
  plan.commands.push('ollama list  → ollama rm <each>');
  plan.paths.push(OLLAMA_DIR);
  if (OLLAMA_APP) plan.paths.push(OLLAMA_APP);
  plan.notes.push('Ollama application + ~/.ollama removed entirely.');
} else if (scope === 'subcast-only') {
  plan.notes.push('Ollama untouched.');
}

// ── present the plan ────────────────────────────────────────────────
const header = DRY ? '  DRY RUN  ' : '  EXECUTING  ';
console.log(`\n┌──${'─'.repeat(header.length)}──┐`);
console.log(`│  ${header}  │   reset-for-first-run · scope=${scope}`);
console.log(`└──${'─'.repeat(header.length)}──┘\n`);

console.log('Filesystem targets:');
let totalBytes = 0;
let anyExists = false;
for (const p of plan.paths) {
  const info = listIfExists(p);
  if (info) {
    anyExists = true;
    totalBytes += info.size;
    console.log(`  ✓ ${p}`);
    console.log(`      size: ${humanSize(info.size)} · ${info.children.length} entries`);
  } else {
    console.log(`  – ${p}  (does not exist; skip)`);
  }
}
console.log(`\n  total to free: ${humanSize(totalBytes)}\n`);

console.log('Ollama commands:');
for (const c of plan.commands) console.log(`  $ ${c}`);
if (plan.commands.length === 0) console.log('  (none)');
console.log();

if (plan.notes.length) {
  console.log('Notes:');
  for (const n of plan.notes) console.log(`  · ${n}`);
  console.log();
}

if (DRY) {
  if (!anyExists && plan.commands.length === 0) {
    console.log('Nothing to do — already at first-run state.\n');
  } else {
    console.log('Re-run with `--yes` to actually delete.\n');
    if (BACKUP) console.log('(`--backup` will be honored when you re-run with --yes.)\n');
  }
  process.exit(0);
}

// ── execution path ──────────────────────────────────────────────────

if (BACKUP) {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const backupFile = join(HOME, 'Desktop', `subcast-backup-${stamp}.tar.gz`);
  if (existsSync(SUBCAST_USER_DATA)) {
    console.log(`Backing up Subcast userData → ${backupFile} ...`);
    try {
      execSync(
        `tar -czf "${backupFile}" -C "${join(SUBCAST_USER_DATA, '..')}" "${basename(SUBCAST_USER_DATA)}"`,
        { stdio: 'inherit' },
      );
      console.log('  backup ok.\n');
    } catch (err) {
      console.error(`  backup failed: ${err.message}`);
      console.error('Aborting before any destructive step.');
      process.exit(1);
    }
  } else {
    console.log('Backup requested but Subcast userData does not exist; skipping.\n');
  }
}

// Try to stop running Subcast / Electron / Ollama model first so file
// handles release. Best-effort; failures here are non-fatal.
function tryKill(matcher) {
  const r = spawnSync('pkill', ['-f', matcher], { stdio: 'ignore' });
  if (r.status === 0) console.log(`  killed processes matching: ${matcher}`);
}
console.log('Stopping live processes:');
tryKill('Electron.*subcast');
tryKill('Subcast.app');
// ollama stop is per-model; the actual ollama server keeps running.
spawnSync('ollama', ['stop', 'qwen2.5:14b'], { stdio: 'ignore' });
console.log();

// Ollama commands.
function ollamaList() {
  const r = spawnSync('ollama', ['list'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .slice(1) // skip header
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n && n !== 'NAME');
}

if (scope === 'wizard') {
  console.log('$ ollama rm qwen2.5:14b');
  spawnSync('ollama', ['rm', 'qwen2.5:14b'], { stdio: 'inherit' });
} else if (scope === 'models' || scope === 'clean') {
  const models = ollamaList();
  if (models.length === 0) {
    console.log('(no Ollama models to remove)');
  } else {
    for (const m of models) {
      console.log(`$ ollama rm ${m}`);
      spawnSync('ollama', ['rm', m], { stdio: 'inherit' });
    }
  }
}
console.log();

// Filesystem removals.
console.log('Removing paths:');
for (const p of plan.paths) {
  if (!existsSync(p)) continue;
  try {
    rmSync(p, { recursive: true, force: true });
    console.log(`  ✓ ${p}`);
  } catch (err) {
    console.error(`  ✗ ${p} — ${err.message}`);
  }
}

console.log(`\nDone. Launch Subcast to verify the setup wizard appears.\n`);
