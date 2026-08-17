/* SPDX-License-Identifier: Apache-2.0 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SidecarProcessStatus {
  llamaServer: boolean;
  whisperServer: boolean;
}

export interface SidecarProcessStatusOptions {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  roots?: string[];
}

/**
 * Privacy-safe process presence probe used only as a runtime-status
 * fallback. It returns booleans, never command lines, paths, ports, or PIDs.
 */
export async function detectSubcastSidecars(
  opts: SidecarProcessStatusOptions = {},
): Promise<SidecarProcessStatus> {
  if (process.platform === 'win32' && !opts.exec) {
    return { llamaServer: false, whisperServer: false };
  }

  const roots = (opts.roots ?? [
    process.env.SUBCAST_HOME,
    process.env.SUBCAST_RESOURCES_PATH,
    process.cwd(),
  ]).filter((v): v is string => typeof v === 'string' && v.length > 0);

  if (roots.length === 0) {
    return { llamaServer: false, whisperServer: false };
  }

  const run = opts.exec
    ? (cmd: string, args: string[]) => opts.exec!(cmd, args)
    : (cmd: string, args: string[]) => execFileAsync(cmd, args);

  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
    const status: SidecarProcessStatus = { llamaServer: false, whisperServer: false };
    for (const line of stdout.split('\n')) {
      if (!roots.some((root) => line.includes(root))) continue;
      if (/\bllama-server(?:\.exe)?\b/.test(line)) status.llamaServer = true;
      if (/\bwhisper-server(?:\.exe)?\b/.test(line)) status.whisperServer = true;
      if (status.llamaServer && status.whisperServer) break;
    }
    return status;
  } catch {
    return { llamaServer: false, whisperServer: false };
  }
}
