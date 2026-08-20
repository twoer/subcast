/* SPDX-License-Identifier: Apache-2.0 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROFILE_NAME = 'agent-access.json';

export interface AgentAccessProfile {
  schemaVersion: 1;
  baseUrl: string;
  token: string;
  allowedRoutes: ['/api/agent/*', '/api/transcribe', '/api/insights'];
}

export function agentAccessProfilePath(home: string): string {
  return join(home, PROFILE_NAME);
}

export function writeAgentAccessProfile(input: {
  home: string;
  baseUrl: string;
  token: string;
}): string {
  const path = agentAccessProfilePath(input.home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const profile: AgentAccessProfile = {
    schemaVersion: 1,
    baseUrl: input.baseUrl,
    token: input.token,
    allowedRoutes: ['/api/agent/*', '/api/transcribe', '/api/insights'],
  };
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function clearAgentAccessProfile(home: string): void {
  const path = agentAccessProfilePath(home);
  if (existsSync(path)) rmSync(path, { force: true });
}

export function hasAgentAccessProfile(home: string): boolean {
  return existsSync(agentAccessProfilePath(home));
}

export function readAgentAccessProfile(path: string): AgentAccessProfile {
  if (!existsSync(path)) {
    const err = new Error('AGENT_ACCESS_NOT_ENABLED');
    err.name = 'AGENT_ACCESS_NOT_ENABLED';
    throw err;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentAccessProfile>;
    const url = typeof parsed.baseUrl === 'string' ? new URL(parsed.baseUrl) : null;
    if (
      parsed.schemaVersion !== 1
      || !url
      || url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || typeof parsed.token !== 'string'
      || parsed.token.length === 0
    ) {
      throw new Error('invalid profile');
    }
    return {
      schemaVersion: 1,
      baseUrl: url.origin,
      token: parsed.token,
      allowedRoutes: ['/api/agent/*', '/api/transcribe', '/api/insights'],
    };
  } catch {
    const err = new Error('INVALID_AGENT_ACCESS_PROFILE');
    err.name = 'INVALID_AGENT_ACCESS_PROFILE';
    throw err;
  }
}
