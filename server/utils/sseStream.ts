/* SPDX-License-Identifier: Apache-2.0 */

/**
 * SSE response helper. Centralises the boilerplate that every text/event-stream
 * endpoint needs and closes three failure modes that the inline patterns left
 * open:
 *
 *   1. **Silent TCP drop** — `req.on('close')` only fires after a clean FIN.
 *      A Wi-Fi blip / sleep / kill -9 client leaves the socket half-open until
 *      kernel keepalive eventually times out (minutes to hours). We enable
 *      socket keepalive at 30s and treat write-errors as immediate close.
 *
 *   2. **Backpressure → death** — a busted client whose recv-buffer is full
 *      makes `stream.write()` throw EPIPE; without catching, the iterator
 *      keeps consuming queue frames the client will never see.
 *
 *   3. **Forever-running heartbeat** — a hard lifetime cap forces the loop
 *      to exit so an abandoned tab doesn't keep a worker stream attached
 *      for the lifetime of the server process.
 */

import type { H3Event } from 'h3';
import { setResponseHeaders } from 'h3';

const HEARTBEAT_INTERVAL_MS = 15_000;
// 2h hard cap per connection. Bumped from 1h after AI Insights on long
// transcripts (10k+ tokens with 14B Q4) ran up against the limit on slow
// hardware — generation can legitimately take 30-60 min and we want a
// margin. A truly stuck stream still gets terminated; this is a zombie-
// tab safety, not an SLA.
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const TCP_KEEPALIVE_MS = 30_000;

export interface SseStreamHandle {
  /** Write a frame. Returns false once the stream is dead — caller should bail. */
  write(text: string): boolean;
  /** True once the connection has been torn down (client close, error, or lifetime cap). */
  isClosed(): boolean;
  /** Idempotent; clears timers and ends the response if still open. */
  close(): void;
}

export function setupSseStream(event: H3Event): SseStreamHandle {
  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const req = event.node.req;
  const res = event.node.res;
  let closed = false;

  // TCP-level keepalive catches silent drops far sooner than the OS default.
  // Best-effort; some socket types (Unix domain, mocks) don't support it.
  try {
    req.socket?.setKeepAlive(true, TCP_KEEPALIVE_MS);
  } catch {
    // ignore — not all socket implementations support keepalive
  }

  const markClosed = (): void => {
    closed = true;
  };

  req.on('close', markClosed);
  req.on('error', markClosed);
  res.on('close', markClosed);
  res.on('error', markClosed);

  const write = (text: string): boolean => {
    if (closed) return false;
    try {
      res.write(text);
      return true;
    } catch {
      // EPIPE / ECONNRESET / write-after-end — treat as closed.
      markClosed();
      return false;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);

  const lifetimeCap = setTimeout(markClosed, MAX_LIFETIME_MS);

  return {
    write,
    isClosed: () => closed,
    close(): void {
      clearInterval(heartbeat);
      clearTimeout(lifetimeCap);
      if (!closed) {
        markClosed();
        try {
          res.end();
        } catch {
          // already gone
        }
      }
    },
  };
}
