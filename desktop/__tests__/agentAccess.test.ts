/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentAccessProfilePath, clearAgentAccessProfile, hasAgentAccessProfile, readAgentAccessProfile, writeAgentAccessProfile } from '../agentAccess';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent access profile', () => {
  it('writes a scoped profile with owner-only permissions', () => {
    const home = mkdtempSync(join(tmpdir(), 'subcast-agent-access-'));
    roots.push(home);

    const path = writeAgentAccessProfile({
      home,
      baseUrl: 'http://127.0.0.1:51301',
      token: 'temporary-token',
    });

    expect(path).toBe(agentAccessProfilePath(home));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      baseUrl: 'http://127.0.0.1:51301',
      token: 'temporary-token',
      allowedRoutes: ['/api/agent/*', '/api/transcribe', '/api/insights'],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('removes a stale profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'subcast-agent-access-'));
    roots.push(home);
    const path = writeAgentAccessProfile({ home, baseUrl: 'http://127.0.0.1:51301', token: 'temporary-token' });

    clearAgentAccessProfile(home);

    expect(existsSync(path)).toBe(false);
    expect(hasAgentAccessProfile(home)).toBe(false);
  });

  it('redacts malformed profile failures behind a stable error code', () => {
    const home = mkdtempSync(join(tmpdir(), 'subcast-agent-access-'));
    roots.push(home);
    const path = agentAccessProfilePath(home);
    writeFileSync(path, '{not valid json');

    expect(() => readAgentAccessProfile(path)).toThrowError(expect.objectContaining({ name: 'INVALID_AGENT_ACCESS_PROFILE' }));
  });
});
