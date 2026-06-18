/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { execPath } from 'node:process';
import {
  ProcessAbortedError,
  ProcessTimeoutError,
  runProcess,
} from '../process';

// All cases shell out to the current `node` binary so the tests don't
// depend on POSIX-only tools (sleep, etc.). Each `-e` payload is short.

describe('runProcess', () => {
  it('captures stdout and returns code 0 on normal exit', async () => {
    const r = await runProcess(
      execPath,
      ['-e', `process.stdout.write('hello')`],
      { label: 'echo' },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello');
    expect(r.stderr).toBe('');
    expect(r.truncated).toBe(false);
  });

  it('captures non-zero exit without throwing', async () => {
    const r = await runProcess(
      execPath,
      ['-e', `process.stderr.write('boom'); process.exit(7)`],
      { label: 'boom' },
    );
    expect(r.code).toBe(7);
    expect(r.stderr).toBe('boom');
  });

  it('rejects with ProcessTimeoutError when timeoutMs is exceeded', async () => {
    const started = Date.now();
    await expect(
      runProcess(
        execPath,
        // hang forever
        ['-e', `setInterval(() => {}, 1000)`],
        { label: 'hang', timeoutMs: 200, killGraceMs: 100 },
      ),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
    // SIGTERM should kill node quickly; well under killGraceMs + slack.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects with ProcessAbortedError when external signal fires', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    await expect(
      runProcess(
        execPath,
        ['-e', `setInterval(() => {}, 1000)`],
        { label: 'abortable', signal: ctl.signal, killGraceMs: 100 },
      ),
    ).rejects.toBeInstanceOf(ProcessAbortedError);
  });

  it('rejects immediately if signal is already aborted before spawn', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runProcess(execPath, ['-e', `1+1`], {
        label: 'pre-aborted',
        signal: ctl.signal,
      }),
    ).rejects.toBeInstanceOf(ProcessAbortedError);
  });

  it('rejects with spawn error for missing binary', async () => {
    await expect(
      runProcess('/nonexistent/path/to/binary', [], { label: 'missing' }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('truncates stdout once it exceeds maxBufferBytes', async () => {
    // Write ~30 KiB of stdout with maxBufferBytes=4 KiB → must be truncated
    // and the marker string must appear in the result.
    const r = await runProcess(
      execPath,
      [
        '-e',
        `const chunk='x'.repeat(1024); for (let i=0;i<30;i++) process.stdout.write(chunk + '\\n');`,
      ],
      { label: 'big-stdout', maxBufferBytes: 4096 },
    );
    expect(r.code).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain('truncated');
    // Sanity: total captured length should be roughly maxBufferBytes + the
    // separator, far less than the ~30 KiB written.
    expect(r.stdout.length).toBeLessThan(10_000);
  });
});
