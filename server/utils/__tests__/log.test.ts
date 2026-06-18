/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SUBCAST_PATHS is sourced from db.ts, which transitively loads better-sqlite3
// — a native module that can fail to load under Node version drift. Stub the
// dependency before importing log.ts so this test runs regardless.
const tmpLogsDir = mkdtempSync(join(tmpdir(), 'log-test-'));

vi.mock('../db', () => ({
  SUBCAST_PATHS: {
    home: tmpLogsDir,
    videos: join(tmpLogsDir, 'videos'),
    cache: join(tmpLogsDir, 'cache'),
    logs: tmpLogsDir,
    tmp: join(tmpLogsDir, 'tmp'),
  },
}));

// Import after the mock is registered.
const logModule = await import('../log');
const { logEvent, getLogHealth, _flushLogWritesForTest } = logModule;

describe('getLogHealth', () => {
  beforeAll(() => {
    // Touch the module so its top-level state is initialised.
    expect(typeof logEvent).toBe('function');
  });

  it('starts ok with no failures recorded', () => {
    const h = getLogHealth();
    expect(h.ok).toBe(true);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.totalFailures).toBeGreaterThanOrEqual(0);
  });

  it('records lastSuccessAt after a successful write', async () => {
    const before = Date.now();
    logEvent({ level: 'info', event: 'test_success' });
    await _flushLogWritesForTest();
    const h = getLogHealth();
    expect(h.ok).toBe(true);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastSuccessAt).toBeGreaterThanOrEqual(before);
  });

  it('returns a stable shape (all fields present)', () => {
    const h = getLogHealth();
    expect(h).toHaveProperty('ok');
    expect(h).toHaveProperty('consecutiveFailures');
    expect(h).toHaveProperty('totalFailures');
    expect(h).toHaveProperty('lastError');
    expect(h).toHaveProperty('lastFailureAt');
    expect(h).toHaveProperty('lastSuccessAt');
  });
});

describe('logEvent', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('does not throw on a normal call', () => {
    expect(() => logEvent({ level: 'info', event: 'no_throw' })).not.toThrow();
  });

  it('accepts arbitrary extra fields', () => {
    expect(() =>
      logEvent({
        level: 'warn',
        event: 'extra_fields',
        taskId: 't-1',
        custom: { nested: true },
      }),
    ).not.toThrow();
  });
});
