#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const force = process.argv.slice(2).includes('--force');
const source = resolve(process.cwd(), 'skills', 'subcast');
const codexRoot = process.env.CODEX_HOME || join(homedir(), '.codex');
const destination = join(codexRoot, 'skills', 'subcast');

if (!existsSync(source)) {
  throw new Error(`SOURCE_SKILL_NOT_FOUND: ${source}`);
}
if (existsSync(destination)) {
  if (!force) {
    throw new Error(`SKILL_ALREADY_INSTALLED: ${destination} (run pnpm skill:install -- --force to replace it)`);
  }
  rmSync(destination, { recursive: true, force: true });
}

cpSync(source, destination, { recursive: true });
console.log(JSON.stringify({ ok: true, skill: 'subcast', destination }));

