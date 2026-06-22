/* SPDX-License-Identifier: Apache-2.0 */
//
// Regression coverage for the P1 fix in docs/reviews/2026-06-22-url-import-review.md:
// `tryStartNext()` must reserve the single execution slot *synchronously*
// (before its first await), so two concurrent `ensureTask()` calls cannot
// both observe `this.current === null`, both shift the queue, and both
// spawn yt-dlp — breaking the one-at-a-time contract.
//
// We mock `node:child_process` so no real yt-dlp is spawned. The fake
// ChildProcess stays alive (never emits 'exit') until the test ends, so
// the slot stays reserved and we can assert on the queue's invariants.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- fake ChildProcess -----------------------------------------------------
// Minimal EventEmitter-shaped stand-in. The queue only uses: stdio pipes
// (as Node streams with setEncoding/on), once('exit'|'error'), kill(), and
// exitCode. We implement just enough for runTask() to attach handlers and
// block on `await new Promise(resolve => proc.once('exit', resolve))`.
class FakeChildProcess {
  stdout = new TargetStream();
  stderr = new TargetStream();
  exitCode: number | null = null;
  killed = false;
  private exitListeners = new Set<() => void>();
  private errorListeners = new Set<(err: Error) => void>();
  once(event: 'exit' | 'error', fn: (...args: unknown[]) => void): this {
    if (event === 'exit') this.exitListeners.add(fn as () => void);
    if (event === 'error') this.errorListeners.add(fn as (err: Error) => void);
    return this;
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
  /** Test helper: fire exit to unblock runTask's awaiter. */
  emitExit(code: number): void {
    this.exitCode = code;
    for (const fn of this.exitListeners) fn();
    this.exitListeners.clear();
  }
}

class TargetStream {
  private encoding = '';
  private dataListeners = new Set<(chunk: string) => void>();
  setEncoding(enc: string): void {
    this.encoding = enc;
  }
  on(event: 'data', fn: (chunk: string) => void): this {
    if (event === 'data') this.dataListeners.add(fn);
    return this;
  }
  /** Test helper: push a line to all registered 'data' handlers. */
  push(chunk: string): void {
    for (const fn of this.dataListeners) fn(chunk);
  }
}

// Hoist the spawn mock state so the module-level `vi.mock` can see it.
const spawnMock = vi.hoisted(() => {
  return { calls: 0, lastFake: null as FakeChildProcess | null };
});

vi.mock('node:child_process', () => ({
  spawn: () => {
    spawnMock.calls++;
    const fake = new FakeChildProcess();
    spawnMock.lastFake = fake;
    return fake;
  },
}));

// Set SUBCAST_HOME before importing the queue / db so migrations run in a
// throwaway dir (mirrors urlImportQueue.test.ts).
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  const home = mkdtempSync(join(tmpdir(), 'subcast-urlimport-concurrency-'));
  process.env.SUBCAST_HOME = home;
  mkdirSync(join(home, 'videos'), { recursive: true });
  mkdirSync(join(home, 'tmp', 'urlimport'), { recursive: true });
});

/* eslint-disable import/first -- SUBCAST_HOME + mock must be set before import */
import { urlImportQueue } from '../urlImportQueue';
/* eslint-enable import/first */

// The queue instance keeps `current` private; for white-box concurrency
// assertions we cast to a shape that exposes it. This is a test-only leak
// of internal state, intentional and scoped to this file.
type QueueInternals = {
  current: { task: { id: string }; proc: unknown } | null;
  queue: string[];
};

describe('urlImportQueue concurrency (P1 fix)', () => {
  let internals: QueueInternals;

  beforeEach(async () => {
    // The queue is a module-level singleton; drain any fake ChildProcess
    // left running by a previous test so each test starts with an empty
    // slot. Each emitExit(0) triggers the queue's finally → tryStartNext,
    // which may spawn another fake for a previously-queued task; loop
    // until the queue is fully idle.
    let drained = false;
    while (!drained) {
      if (spawnMock.lastFake) {
        spawnMock.lastFake.emitExit(0);
        spawnMock.lastFake = null;
      }
      await new Promise((r) => setImmediate(r));
      // Idle when there's no current slot and nothing pending.
      internals = urlImportQueue as unknown as QueueInternals;
      if (!internals.current && internals.queue.length === 0 && !spawnMock.lastFake) {
        drained = true;
      }
    }
    spawnMock.calls = 0;
    spawnMock.lastFake = null;
  });

  it('reserves the execution slot synchronously before the first await', () => {
    // ensureTask pushes to the queue then fires `void tryStartNext()`.
    // tryStartNext runs synchronously up to `await runTask()` → `await
    // mkdir(...)`; before that await it must have set `this.current`.
    // So immediately after ensureTask() returns (no awaits in the test
    // frame between here and there beyond the microtasks the void call
    // already scheduled), the slot is occupied.
    const task = urlImportQueue.ensureTask('https://example.com/concurrency-a');
    expect(internals.current).not.toBeNull();
    expect(internals.current!.task.id).toBe(task.id);
    expect(internals.queue).toHaveLength(0);
  });

  it('does not start a second yt-dlp while the first slot is occupied', () => {
    // First call reserves the slot synchronously and (after the mkdir
    // microtask) spawns yt-dlp exactly once.
    urlImportQueue.ensureTask('https://example.com/concurrency-b');
    // Second URL arrives while the first is still in flight. It must be
    // enqueued, NOT spawn another process — the pre-fix bug was that both
    // observed current === null and both spawned.
    const second = urlImportQueue.ensureTask('https://example.com/concurrency-c');
    expect(internals.queue).toContain(second.id);
    expect(internals.current!.task.id).not.toBe(second.id);
    // Only one spawn so far. We allow the event loop to drain so the first
    // task's mkdir + spawn microtask has a chance to run, then assert no
    // second spawn happened.
    expect(spawnMock.calls).toBeLessThanOrEqual(1);
  });

  it('frees the slot and starts the next task after the running one exits', async () => {
    // beforeEach already drained the singleton; slot is empty here.
    const first = urlImportQueue.ensureTask('https://example.com/concurrency-d');
    const second = urlImportQueue.ensureTask('https://example.com/concurrency-e');
    // mkdir is async (libuv thread); pump the event loop until the first
    // task's spawn has actually happened.
    for (let i = 0; i < 10 && !spawnMock.lastFake; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(internals.current).not.toBeNull();
    expect(internals.current!.task.id).toBe(first.id);
    expect(internals.queue).toContain(second.id);

    const callsBefore = spawnMock.calls;
    // Fail the first download (non-zero exit) so runTask unwinds and the
    // finally releases the slot + calls tryStartNext() for the second.
    const fake = spawnMock.lastFake!;
    fake.stderr.push('[fake] simulated failure\n');
    fake.emitExit(1);
    // Allow the catch/finally + next tryStartNext microtasks to run, then
    // the second task's mkdir + spawn.
    for (let i = 0; i < 10 && spawnMock.calls !== callsBefore + 1; i++) {
      await new Promise((r) => setImmediate(r));
    }
    // The first task must no longer hold the slot...
    expect(internals.current?.task.id).not.toBe(first.id);
    // ...and a second spawn must have happened for the queued task.
    expect(spawnMock.calls).toBe(callsBefore + 1);
  });

  it('cancel() during the pre-spawn window aborts before yt-dlp launches', async () => {
    // P1 follow-up regression: tryStartNext() reserves the slot with
    // proc = null, then runTask awaits mkdir. If cancel() arrives in that
    // window it can only set task.phase = 'canceled' (no proc to kill).
    // runTaskInner MUST check phase after the await and return without
    // spawning — otherwise the download runs anyway, defeating the cancel.
    const callsBefore = spawnMock.calls;
    const task = urlImportQueue.ensureTask('https://example.com/concurrency-cancel');

    // Synchronously cancel before mkdir resolves. ensureTask returned after
    // void tryStartNext() ran up to `await mkdir`; the fs callback hasn't
    // fired yet, so we are inside the vulnerable window.
    const canceled = urlImportQueue.cancel(task.id);
    expect(canceled).toBe(true);

    // Pump the event loop so mkdir resolves and runTaskInner runs its
    // post-await check + finally.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // No yt-dlp spawn should have happened for this task.
    expect(spawnMock.calls).toBe(callsBefore);
    // The slot is released by the finally so the queue isn't stuck.
    expect(internals.current?.task.id).not.toBe(task.id);
    // And the task is in the canceled terminal phase, not fetching_info.
    expect(urlImportQueue.getTask(task.id)?.phase).toBe('canceled');
  });

  it('cancel() a queued (not-yet-started) task drops it without spawning', () => {
    // Occupy the slot with one task so a second task stays queued.
    const running = urlImportQueue.ensureTask('https://example.com/concurrency-queued-running');
    const queued = urlImportQueue.ensureTask('https://example.com/concurrency-queued-waiting');
    expect(internals.queue).toContain(queued.id);

    const callsBefore = spawnMock.calls;
    const canceled = urlImportQueue.cancel(queued.id);
    expect(canceled).toBe(true);
    expect(internals.queue).not.toContain(queued.id);
    // Canceling the queued task must not have spawned anything new.
    expect(spawnMock.calls).toBe(callsBefore);
    // The running task still holds the slot.
    expect(internals.current?.task.id).toBe(running.id);
  });
});
