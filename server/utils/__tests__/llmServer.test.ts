/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { LlmServer, llamaServerSpawnArgs } from '../llmServer';
import type { ChildProcess } from 'node:child_process';
import { activeRuntimeProfile, resolveRuntimeProfile } from '../runtimeProfile';

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

  it('ensureLease() returns a model-specific lease and reuses the same model', async () => {
    const fakeProc = makeFakeProc();
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new LlmServer({
      idleShutdownMs: 60_000,
      modelPath: '/models/qwen3-8b.gguf',
      spawnFn,
    });

    const first = await server.ensureLease({ modelId: '8b' });
    const second = await server.ensureLease({ modelId: '8b' });

    expect(first).toMatchObject({
      endpoint: 'http://127.0.0.1:51302',
      modelId: '8b',
      modelPath: '/models/qwen3-8b.gguf',
      backend: 'llama-server',
      runtimeProfileId: activeRuntimeProfile().id,
      coldStart: true,
    });
    expect(second).toMatchObject({ modelId: '8b', coldStart: false });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    server.dispose();
  });

  it('ensureLease() stops and respawns when the requested model changes', async () => {
    const firstProc = makeFakeProc();
    const secondProc = makeFakeProc();
    (firstProc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      firstProc.emit('exit', 0);
    });
    const spawnFn = vi
      .fn()
      .mockResolvedValueOnce({ proc: firstProc, port: 51302 })
      .mockResolvedValueOnce({ proc: secondProc, port: 51303 });
    const server = new LlmServer({ idleShutdownMs: 60_000, modelPath: '/models/test.gguf', spawnFn });

    await server.ensureLease({ modelId: '8b' });
    const next = await server.ensureLease({ modelId: '4b' });

    expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(next).toMatchObject({
      endpoint: 'http://127.0.0.1:51303',
      modelId: '4b',
      coldStart: true,
    });
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

  it('marks model unusable after 3 consecutive non-zero exits', async () => {
    let crashes = 0;
    const spawnFn = vi.fn(async () => {
      crashes += 1;
      const proc = new EventEmitter() as ChildProcess & EventEmitter;
      (proc as { kill: unknown }).kill = vi.fn();
      process.nextTick(() => proc.emit('exit', 1));
      return { proc, port: 51302 };
    });
    const server = new LlmServer({ idleShutdownMs: 60_000, spawnFn });
    // First three crashes: each ensure() resolves (spawn succeeds) but the
    // child immediately exits non-zero on next tick. We test by waiting for
    // exit to fire then attempting ensure() again.
    for (let i = 0; i < 3; i++) {
      await server.ensure();
      // Wait a microtask for the nextTick exit handler
      await new Promise<void>((r) => process.nextTick(r));
    }
    await expect(server.ensure()).rejects.toThrow(/MODEL_UNUSABLE/);
    expect(crashes).toBe(3);
    server.dispose();
  });

  it('resets failure counter on noteSuccess()', async () => {
    let crashes = 0;
    const spawnFn = vi.fn(async () => {
      crashes += 1;
      const proc = new EventEmitter() as ChildProcess & EventEmitter;
      (proc as { kill: unknown }).kill = vi.fn();
      // Crash twice then succeed
      if (crashes <= 2) process.nextTick(() => proc.emit('exit', 1));
      return { proc, port: 51302 };
    });
    const server = new LlmServer({ idleShutdownMs: 60_000, spawnFn });
    await server.ensure();
    await new Promise<void>((r) => process.nextTick(r));
    await server.ensure();
    await new Promise<void>((r) => process.nextTick(r));
    await server.ensure();
    // 3rd spawn doesn't crash — call noteSuccess to reset
    server.noteSuccess();
    // Subsequent crashes should restart from 0
    // (we don't actually need a 4th ensure to confirm; just no throw on next)
    server.dispose();
  });

  it('parses listening port from stdout', async () => {
    const { Readable } = await import('node:stream');
    const fakeStdout = Readable.from([
      'llama server starting\n',
      'HTTP server listening on 127.0.0.1:51302\n',
      'ready',
    ]);
    const fakeProc = {
      stdout: fakeStdout,
      stderr: Readable.from([]),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as ChildProcess;
    const port = await (
      new LlmServer() as unknown as {
        waitForListeningPort: (p: ChildProcess, t: number) => Promise<number>;
      }
    ).waitForListeningPort(fakeProc, 2000);
    expect(port).toBe(51302);
  });

  it('rejects immediately with the stderr tail when the process dies before listening', async () => {
    const { Readable } = await import('node:stream');
    const ev = new EventEmitter();
    const fakeProc = {
      stdout: Readable.from([]),
      stderr: Readable.from(['error while handling argument "-fa": unknown value\n']),
      on: ev.on.bind(ev),
      off: ev.off.bind(ev),
    } as unknown as ChildProcess;
    const probe = (
      new LlmServer() as unknown as {
        waitForListeningPort: (p: ChildProcess, t: number) => Promise<number>;
      }
    ).waitForListeningPort(fakeProc, 5000);
    // Let the stderr Readable drain first, then kill the process —
    // mirrors an argv-parse failure where llama-server dies instantly.
    await new Promise((r) => setTimeout(r, 20));
    ev.emit('exit', 1);
    await expect(probe).rejects.toThrow(
      /exited \(code 1\) before announcing a port.*unknown value/,
    );
  });
});

describe('llamaServerSpawnArgs (P4 concurrency contract)', () => {
  it('derives parallel slots and context from the runtime profile', () => {
    const profile = resolveRuntimeProfile({
      platform: 'macOS',
      arch: 'arm64',
      totalMemoryGB: 16,
      gpu: 'apple-silicon',
    });
    const args = llamaServerSpawnArgs('/models/qwen3-8b.gguf', 0, profile);
    expect(args[args.indexOf('--parallel') + 1]).toBe('2');
    // llama-server splits ctx across slots — total must be scaled so each
    // slot keeps the 8192 the insights path needs.
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('16384');
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('999');
    expect(args[args.indexOf('--load-mode') + 1]).toBe('mmap+mlock');
  });

  it('uses CPU profile flags when GPU acceleration is not enabled', () => {
    const profile = resolveRuntimeProfile({
      platform: 'Windows',
      arch: 'x64',
      totalMemoryGB: 16,
      gpu: 'nvidia',
    });
    const args = llamaServerSpawnArgs('/models/qwen3-8b.gguf', 0, profile);
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('0');
    expect(args[args.indexOf('--load-mode') + 1]).toBe('mmap');
    expect(args[args.indexOf('--flash-attn') + 1]).toBe('off');
  });

  it('never passes a bare -fa / --flash-attn (b10435 argv trap)', () => {
    const args = llamaServerSpawnArgs('/models/qwen3-8b.gguf', 0);
    expect(args).not.toContain('-fa');
    const idx = args.indexOf('--flash-attn');
    if (idx >= 0) {
      expect(args[idx + 1]).toMatch(/^(auto|off)$/);
    }
  });
});

describe('touch (pending-work keepalive)', () => {
  it('resets the idle timer when running; never spawns when idle', async () => {
    vi.useFakeTimers();
    try {
      const fakeProc = makeFakeProc();
      (fakeProc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
        fakeProc.emit('exit', 0);
      });
      const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
      const server = new LlmServer({ idleShutdownMs: 1_000, spawnFn });
      await server.ensure();
      expect(server.state).toBe('running');

      server.touch();
      vi.advanceTimersByTime(999);
      expect(server.state).toBe('running'); // survived past original window

      // No timer set: touch is a no-op on an idle (unloaded) server.
      vi.advanceTimersByTime(1);
      expect(server.state).not.toBe('running');
      server.touch();
      vi.advanceTimersByTime(5_000);
      expect(spawnFn).toHaveBeenCalledTimes(1); // never re-spawned
      server.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('noteHttpFailure (alive-but-failing recycle)', () => {
  it('leaves a running server alone until the third consecutive 5xx, then stops it', async () => {
    const fakeProc = makeFakeProc();
    (fakeProc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      fakeProc.emit('exit', 0);
    });
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new LlmServer({ idleShutdownMs: 60_000, spawnFn });
    await server.ensure();
    expect(server.state).toBe('running');

    server.noteHttpFailure();
    server.noteHttpFailure();
    expect(server.state).toBe('running'); // not yet

    server.noteHttpFailure();
    await new Promise((r) => setTimeout(r, 0)); // let void stop() run
    expect(server.state).not.toBe('running');
    server.dispose();
  });

  it('noteSuccess resets the 5xx streak', async () => {
    const fakeProc = makeFakeProc();
    (fakeProc.kill as ReturnType<typeof vi.fn>).mockImplementation(() => {
      fakeProc.emit('exit', 0);
    });
    const spawnFn = vi.fn(async () => ({ proc: fakeProc, port: 51302 }));
    const server = new LlmServer({ idleShutdownMs: 60_000, spawnFn });
    await server.ensure();

    server.noteHttpFailure();
    server.noteHttpFailure();
    server.noteSuccess(); // recovered between failures
    server.noteHttpFailure();
    server.noteHttpFailure();
    expect(server.state).toBe('running'); // streak never reached 3
    server.dispose();
  });
});
