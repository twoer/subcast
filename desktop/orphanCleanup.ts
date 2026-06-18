/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Orphan-sidecar cleanup at boot.
 *
 * If Subcast was SIGKILLed (Force Quit, OOM-killer, crashed Electron),
 * the `before-quit` shutdown handler in `main.ts` never ran, so any
 * child sidecars (`llama-server`, `whisper-cli`) survived their parent
 * and were re-parented to PID 1 (launchd on macOS, init/systemd on
 * Linux). They keep listening on their bound TCP ports and would
 * conflict with the next Subcast launch trying to start the same
 * service.
 *
 * On boot we therefore enumerate processes via `ps -A -o pid=,ppid=,comm=`
 * (portable to both macOS and Linux), keep the ones whose PPID is 1 and
 * whose `comm` ends in one of our known sidecar names, and SIGTERM them.
 *
 * Windows is intentionally a no-op stub: v1 doesn't ship the AI sidecars
 * on Windows, and Windows process enumeration would use `tasklist` /
 * `wmic` instead. Returning an empty list keeps the call site
 * cross-platform without leaking platform branches into `main.ts`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Orphan {
  pid: number;
  name: string;
}

export interface FindOrphansOpts {
  /**
   * Injectable `exec` for tests. Receives the same `(cmd, args)` shape
   * as `execFile`. Real callers omit this and we use the bound
   * `execFile` from `node:child_process`.
   */
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
}

/**
 * Enumerate orphaned (PPID === 1) processes whose `comm` ends in one of
 * the requested sidecar names (with optional `.exe` suffix tolerated
 * for forward-compatibility, even though Windows itself is stubbed).
 *
 * On `win32` we short-circuit to an empty list — see file-header note.
 */
export async function findOrphans(
  names: readonly string[],
  opts: FindOrphansOpts = {},
): Promise<Orphan[]> {
  if (process.platform === 'win32' && !opts.exec) {
    // Windows: stubbed for v1 (AI sidecars don't ship on Windows yet).
    // Tests can still exercise the parser by passing a mock `exec`.
    return [];
  }
  const exec = opts.exec
    ? (cmd: string, args: string[]) => opts.exec!(cmd, args)
    : (cmd: string, args: string[]) => execFileAsync(cmd, args);
  // `-A` = all processes; `-o pid=,ppid=,comm=` = three unlabeled
  // columns. The trailing `=` on each format suppresses the header
  // row, but real `ps` output sometimes still includes one on
  // non-standard platforms — the regex below skips any line that
  // doesn't start with digits, so we don't need to special-case it.
  const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,comm=']);
  const orphans: Orphan[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const comm = m[3]!.trim();
    if (ppid !== 1) continue;
    const matched = names.find((n) => comm.endsWith(n) || comm.endsWith(n + '.exe'));
    if (matched) orphans.push({ pid, name: matched });
  }
  return orphans;
}

/**
 * Find and SIGTERM every orphan matching the requested names. Returns
 * the count of orphans we attempted to kill — useful for a one-line
 * boot-time log so users can correlate "I force-quit yesterday" with
 * "Subcast cleaned up 1 stale sidecar".
 *
 * `process.kill` may throw `ESRCH` if the process died between our
 * `ps` snapshot and the signal — that's a benign race, swallow it.
 * Any other error (`EPERM`, etc.) is also swallowed because there's
 * nothing useful we can do at this point in boot; the binary check
 * downstream will catch the resulting port conflict if it matters.
 */
export async function killOrphans(names: readonly string[]): Promise<number> {
  const orphans = await findOrphans(names);
  for (const o of orphans) {
    try {
      process.kill(o.pid, 'SIGTERM');
    } catch {
      // Already gone, or no permission; either way nothing to do here.
    }
  }
  return orphans.length;
}
