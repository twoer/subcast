/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import handler from '../auth-desktop';

function event(path: string, headers: Record<string, string> = {}) {
  return {
    path,
    node: { req: { url: path, headers } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.stubEnv('SUBCAST_DESKTOP', 'true');
  vi.stubEnv('SUBCAST_API_TOKEN', 'desktop-token');
  vi.stubEnv('SUBCAST_AGENT_ACCESS_TOKEN', 'agent-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('desktop auth', () => {
  it('keeps the desktop session token valid for all API routes', () => {
    expect(() => handler(event('/api/settings', { 'x-subcast-token': 'desktop-token' }))).not.toThrow();
  });

  it('limits the agent token to the agent control and processing routes', () => {
    for (const path of ['/api/agent/import', '/api/agent/media/abc', '/api/transcribe', '/api/insights']) {
      expect(() => handler(event(path, { 'x-subcast-agent-token': 'agent-token' }))).not.toThrow();
    }
    let thrown: unknown;
    try {
      handler(event('/api/settings', { 'x-subcast-agent-token': 'agent-token' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      statusCode: 401,
      statusMessage: 'BAD_TOKEN',
    });
  });
});
