/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('../log', () => ({ logEvent: vi.fn() }));

/* eslint-disable import/first -- mocks must be registered before imports */
import { logEvent } from '../log';
import { WhisperServer } from '../whisperServer';
/* eslint-enable import/first */

function makeFakeProc(): ChildProcess {
  const ev = new EventEmitter() as EventEmitter & {
    stdout?: unknown;
    stderr?: unknown;
    kill?: unknown;
    pid?: unknown;
  };
  ev.stdout = new EventEmitter();
  ev.stderr = new EventEmitter();
  ev.kill = vi.fn();
  ev.pid = 1234;
  return ev as unknown as ChildProcess;
}

describe('WhisperServer state machine', () => {
  it('starts in idle', () => {
    const server = new WhisperServer({ idleShutdownMs: 100 });
    expect(server.state).toBe('idle');
    server.dispose();
  });

  it('transitions idle → starting → running on ensure() and reports the port', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new WhisperServer({ idleShutdownMs: 60_000, spawnFn });
    const ready = server.ensure();
    expect(server.state).toBe('starting');
    await ready;
    expect(server.state).toBe('running');
    expect(server.getPort()).toBe(51302);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    server.dispose();
  });

  it('concurrent ensure() calls share one spawn', async () => {
    const fakeProc = makeFakeProc();
    let resolveSpawn: ((v: { proc: ChildProcess; port: number }) => void) | null = null;
    const spawnFn = vi.fn(
      () =>
        new Promise<{ proc: ChildProcess; port: number }>((r) => {
          resolveSpawn = r;
        }),
    );
    const server = new WhisperServer({ idleShutdownMs: 60_000, spawnFn });
    const a = server.ensure();
    const b = server.ensure();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    resolveSpawn!({ proc: fakeProc, port: 51302 });
    await Promise.all([a, b]);
    server.dispose();
  });

  it('schedules shutdown after the idle window', async () => {
    vi.useFakeTimers();
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new WhisperServer({ idleShutdownMs: 1000, spawnFn });
    await server.ensure();
    expect(server.state).toBe('running');
    vi.advanceTimersByTime(1001);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    fakeProc.emit('exit', null);
    expect(server.state).toBe('idle');
    vi.useRealTimers();
  });

  it('latches unusable after three crashed spawns', async () => {
    let crashes = 0;
    const spawnFn = vi.fn(async () => {
      const proc = makeFakeProc();
      crashes += 1;
      if (crashes <= 3) process.nextTick(() => proc.emit('exit', 1));
      return { proc, port: 51302 };
    });
    const server = new WhisperServer({ idleShutdownMs: 60_000, spawnFn });
    // Three ensure() cycles that each die right after spawn.
    for (let i = 0; i < 3; i++) {
      await server.ensure();
      await new Promise<void>((r) => process.nextTick(r));
    }
    await expect(server.ensure()).rejects.toThrow('WHISPER_SERVER_UNUSABLE');
    // noteSuccess must not resurrect a latched server.
    server.noteSuccess();
    await expect(server.ensure()).rejects.toThrow('WHISPER_SERVER_UNUSABLE');
    // Each crash must be visible in the structured log — silent respawns
    // masquerade as multi-second inter-chunk gaps (found in production).
    const crashLogs = vi
      .mocked(logEvent)
      .mock.calls.filter(([e]) => e?.event === 'whisper_server_crashed');
    expect(crashLogs).toHaveLength(3);
    expect(crashLogs[0]![0]).toMatchObject({ code: 1, failureCount: 1 });
  });
});
