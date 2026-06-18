#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-platform wrapper for `SUBCAST_BUILD_TARGET=desktop nuxt build`.
 *
 * The env-inline form `VAR=value nuxt build` in package.json only works
 * under POSIX shells — Windows cmd.exe treats `SUBCAST_BUILD_TARGET=desktop`
 * as a command name and fails with "'SUBCAST_BUILD_TARGET' is not recognized".
 * Setting process.env here before spawning nuxt works on every platform
 * with no extra dependency.
 */
import { spawnSync } from 'node:child_process';

process.env.SUBCAST_BUILD_TARGET = 'desktop';

const result = spawnSync('nuxt', ['build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
