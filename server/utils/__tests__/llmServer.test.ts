/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LlmServer } from '../llmServer';
import type { ChildProcess } from 'node:child_process';

function makeFakeProc(): ChildProcess & EventEmitter {
  const ev = new EventEmitter() as EventEmitter & { stdout?: unknown; stderr?: unknown; kill?: unknown; pid?: unknown };
  ev.stdout = new EventEmitter();
  ev.stderr = new EventEmitter();
  ev.kill = vi.fn();
  ev.pid = 1234;
  return ev as ChildProcess & EventEmitter;
}

describe('LlmServer state machine', () => {
  it('starts in idle', () => {
    const server = new LlmServer({ idleShutdownMs: 100 });
    expect(server.state).toBe('idle');
    server.dispose();
  });

  it('transitions idle → starting → running on ensure()', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new LlmServer({ idleShutdownMs: 60_000, spawnFn });
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
    const spawnFn = vi.fn(() => new Promise<{ proc: ChildProcess; port: number }>((r) => {
      resolveSpawn = r;
    }));
    const server = new LlmServer({ idleShutdownMs: 60_000, spawnFn });
    const a = server.ensure();
    const b = server.ensure();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    resolveSpawn!({ proc: fakeProc, port: 51302 });
    await Promise.all([a, b]);
    server.dispose();
  });

  it('schedules shutdown after idle window with no requests', async () => {
    vi.useFakeTimers();
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new LlmServer({ idleShutdownMs: 1000, spawnFn });
    await server.ensure();
    expect(server.state).toBe('running');
    vi.advanceTimersByTime(1001);
    // Trigger the kill flow; fake proc emits exit synchronously after .kill()
    (fakeProc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      process.nextTick(() => fakeProc.emit('exit', 0));
    });
    await vi.runAllTimersAsync();
    expect(server.state).toBe('idle');
    vi.useRealTimers();
  });

  it('cancels shutdown if request arrives during stopping', async () => {
    vi.useFakeTimers();
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new LlmServer({ idleShutdownMs: 1000, spawnFn });
    await server.ensure();
    vi.advanceTimersByTime(1001);
    // While shutdown is in-flight, another ensure() should re-arm.
    const reEnsure = server.ensure();
    (fakeProc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      process.nextTick(() => fakeProc.emit('exit', 0));
    });
    await vi.runAllTimersAsync();
    await reEnsure;
    expect(server.state).toBe('running');
    vi.useRealTimers();
    server.dispose();
  });

  it('parses listening port from stdout', async () => {
    const { Readable } = await import('node:stream');
    const fakeStdout = Readable.from([
      'llama server starting\n',
      'HTTP server listening on 127.0.0.1:51302\n',
      'ready\n',
    ]);
    const fakeProc = {
      stdout: fakeStdout,
      stderr: Readable.from([]),
      on: vi.fn(),
    } as unknown as ChildProcess;
    const port = await (
      new LlmServer() as unknown as {
        waitForListeningPort: (p: ChildProcess, t: number) => Promise<number>;
      }
    ).waitForListeningPort(fakeProc, 2000);
    expect(port).toBe(51302);
  });
});
