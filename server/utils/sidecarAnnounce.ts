/* SPDX-License-Identifier: Apache-2.0 */
import type { ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

/**
 * Wait for an HTTP sidecar (llama-server / whisper-server) to announce
 * its listening TCP port on stdout/stderr.
 *
 * Both print a "listening" line once the HTTP socket binds:
 *
 *   `main: HTTP server is listening, hostname: 127.0.0.1, port: 52157, ...`
 *   `srv  update_slots: server is listening on http://127.0.0.1:52157 - ...`
 *
 * A process that dies before announcing (bad argv, missing model, OOM)
 * rejects immediately with the sanitized stderr tail — waiting out the
 * full timeout would hide the actual cause (the llama-server `-fa`
 * incident: argv-parse death reported as a bare 30 s port timeout).
 */
export function waitForSidecarListening(
  proc: ChildProcess,
  timeoutMs: number,
  label: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Two formats accepted: `listening, ... port: 52157` and
    // `listening on http://127.0.0.1:52157`. The `.*?` is non-greedy so
    // the port capture is the first numeric port-like token after
    // `listening`, not some unrelated number elsewhere in the line.
    const re = /listening[^\n]*?(?:port[:\s]+|:\/\/[^:]+:|[0-9.]+:)(\d{2,5})/i;
    const stderrTail: string[] = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off('data', onStdout);
      proc.stderr?.off('data', onStderr);
      proc.off('exit', onExit);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} did not announce listening port within ${timeoutMs}ms`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer | string) => {
      const m = re.exec(String(chunk));
      if (m && !settled) {
        settled = true;
        cleanup();
        resolve(Number(m[1]));
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrTail.push(String(chunk));
      if (stderrTail.length > 40) stderrTail.shift();
      onStdout(chunk);
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Paths under HOME leak the username — collapse them before the
      // tail lands in task error messages / diagnostics.
      const tail = stderrTail
        .join('')
        .replace(/\s+/g, ' ')
        .replace(new RegExp((process.env.HOME ?? '/nonexistent').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~')
        .trim()
        .slice(-500);
      reject(
        new Error(
          `${label} exited (code ${code}) before announcing a port` + (tail ? `: ${tail}` : ''),
        ),
      );
    };
    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('exit', onExit);
  });
}

/**
 * Wait for a sidecar to accept TCP connections on a port WE chose.
 *
 * whisper.cpp's server is unusable with the announce-based helper: it
 * prints its "whisper server is listening" line via printf on stdout,
 * which stays block-buffered when stdout is a pipe — the line only
 * flushes at process exit, long after the socket is already bound
 * (verified live: curl succeeds while the line is still buffered).
 *
 * Since the caller probes a free port and passes it explicitly, waiting
 * for that port to accept connections is the reliable readiness signal
 * (whisper.cpp binds only after model load + route setup). Early
 * process death still fast-fails with the sanitized stderr tail.
 */
export function waitForSidecarPortOpen(
  proc: ChildProcess,
  port: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stderrTail: string[] = [];
    let settled = false;
    let probeTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (probeTimer !== null) clearTimeout(probeTimer);
      clearTimeout(deadline);
      proc.stderr?.off('data', onStderr);
      proc.off('exit', onExit);
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${label} did not accept connections on port ${port} within ${timeoutMs}ms`));
    }, timeoutMs);
    const tryConnect = () => {
      if (settled) return;
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (!settled) probeTimer = setTimeout(tryConnect, 250);
      });
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrTail.push(String(chunk));
      if (stderrTail.length > 40) stderrTail.shift();
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const tail = stderrTail
        .join('')
        .replace(/\s+/g, ' ')
        .replace(new RegExp((process.env.HOME ?? '/nonexistent').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~')
        .trim()
        .slice(-500);
      reject(
        new Error(
          `${label} exited (code ${code}) before opening port ${port}` + (tail ? `: ${tail}` : ''),
        ),
      );
    };
    proc.stderr?.on('data', onStderr);
    proc.on('exit', onExit);
    tryConnect();
  });
}
