/* SPDX-License-Identifier: Apache-2.0 */

import { describe, it, expect, vi } from 'vitest';
import { findOrphans } from '../orphanCleanup';

describe('findOrphans', () => {
  it('returns processes matching name and parent === 1', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'PID PPID COMMAND\n1234 1 /path/to/llama-server\n5678 999 something-else',
    }));
    const orphans = await findOrphans(['llama-server', 'whisper-cli'], { exec });
    expect(orphans).toEqual([{ pid: 1234, name: 'llama-server' }]);
  });

  it('matches multiple orphans by basename across both names', async () => {
    const exec = vi.fn(async () => ({
      stdout:
        '1001 1 /usr/local/bin/llama-server\n' +
        '1002 1 /opt/subcast/whisper-cli\n' +
        '1003 2 /opt/subcast/whisper-cli\n' +
        '1004 1 /usr/bin/bash\n',
    }));
    const orphans = await findOrphans(['llama-server', 'whisper-cli'], { exec });
    expect(orphans).toEqual([
      { pid: 1001, name: 'llama-server' },
      { pid: 1002, name: 'whisper-cli' },
    ]);
  });

  it('matches Windows .exe suffix on the binary name', async () => {
    const exec = vi.fn(async () => ({
      stdout: '4242 1 C:\\Program Files\\Subcast\\llama-server.exe\n',
    }));
    const orphans = await findOrphans(['llama-server'], { exec });
    expect(orphans).toEqual([{ pid: 4242, name: 'llama-server' }]);
  });

  it('returns empty list when no match', async () => {
    const exec = vi.fn(async () => ({
      stdout: '1 0 launchd\n42 1 some-daemon\n',
    }));
    const orphans = await findOrphans(['llama-server', 'whisper-cli'], { exec });
    expect(orphans).toEqual([]);
  });

  it('skips malformed lines silently', async () => {
    const exec = vi.fn(async () => ({
      stdout:
        'header garbage\n' +
        '\n' +
        '   \n' +
        'not a row\n' +
        '7 1 /usr/local/bin/llama-server\n',
    }));
    const orphans = await findOrphans(['llama-server'], { exec });
    expect(orphans).toEqual([{ pid: 7, name: 'llama-server' }]);
  });
});
