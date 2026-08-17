/* SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

const { tmpHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const home = mkdtempSync(join(tmpdir(), 'subcast-queue-list-privacy-'));
  process.env.SUBCAST_HOME = home;
  // Nuxt auto-imports defineEventHandler at build time; direct vitest imports
  // need the same tiny shim before the route module is evaluated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).defineEventHandler = (handler: any) => handler;
  return { tmpHome: home };
});

vi.mock('../log', () => ({ logEvent: vi.fn() }));

/* eslint-disable import/first -- hoisted env/mocks must precede imports */
import handler from '../../api/queue/list.get';
import { closeDb, getDb } from '../db';
import { logEvent } from '../log';
/* eslint-enable import/first */

function resetDb(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM diarize_tasks;
    DELETE FROM insight_tasks;
    DELETE FROM polish_tasks;
    DELETE FROM translate_tasks;
    DELETE FROM transcribe_tasks;
    DELETE FROM videos;
  `);
  vi.mocked(logEvent).mockClear();
}

beforeEach(resetDb);

afterAll(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/queue/list privacy logging', () => {
  it('logs empty-queue diagnostics without absolute home paths', () => {
    const res = handler();

    expect(res).toEqual({ items: [] });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'queue_list_empty',
      homeScope: 'configured',
    }));
    const entry = vi.mocked(logEvent).mock.calls.find(([log]) =>
      log.event === 'queue_list_empty'
    )?.[0];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('home');
    expect(entry).not.toHaveProperty('path');
    expect(JSON.stringify(entry)).not.toContain(tmpHome);
  });
});
