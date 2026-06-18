/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { setupSseStream } from '../sseStream';

interface MockEvent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any;
  req: IncomingMessage;
  res: ServerResponse & {
    /** Captured payload from every res.write() call, in order. */
    written: string[];
  };
}

function makeEvent(opts: { writeThrows?: boolean } = {}): MockEvent {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = 'GET';
  req.url = '/api/stream';

  const written: string[] = [];
  const res = new ServerResponse(req) as ServerResponse & { written: string[] };
  res.written = written;
  res.write = ((chunk: string | Buffer) => {
    if (opts.writeThrows) throw new Error('EPIPE');
    written.push(chunk.toString());
    return true;
  }) as typeof res.write;
  res.end = (() => res) as typeof res.end;

  return { event: { node: { req, res } }, req, res };
}

describe('setupSseStream', () => {
  it('sets SSE response headers on setup', () => {
    const { event, res } = makeEvent();
    setupSseStream(event);
    expect(String(res.getHeader('content-type'))).toContain('text/event-stream');
    expect(String(res.getHeader('cache-control'))).toContain('no-cache');
  });

  it('write() returns true on a healthy stream and forwards to res.write', () => {
    const { event, res } = makeEvent();
    const sse = setupSseStream(event);
    expect(sse.write('event: foo\ndata: bar\n\n')).toBe(true);
    expect(res.written.some((w) => w.includes('event: foo'))).toBe(true);
    sse.close();
  });

  it('marks closed when req emits close, and write() returns false thereafter', () => {
    const { event, req } = makeEvent();
    const sse = setupSseStream(event);
    expect(sse.isClosed()).toBe(false);
    req.emit('close');
    expect(sse.isClosed()).toBe(true);
    expect(sse.write('frame')).toBe(false);
    sse.close();
  });

  it('marks closed when res emits error', () => {
    const { event, res } = makeEvent();
    const sse = setupSseStream(event);
    res.emit('error', new Error('downstream'));
    expect(sse.isClosed()).toBe(true);
    sse.close();
  });

  it('treats res.write() throwing (EPIPE/ECONNRESET) as closed', () => {
    const { event } = makeEvent({ writeThrows: true });
    const sse = setupSseStream(event);
    expect(sse.write('frame')).toBe(false);
    expect(sse.isClosed()).toBe(true);
    sse.close();
  });

  it('close() is idempotent and safe after auto-close', () => {
    const { event, req } = makeEvent();
    const sse = setupSseStream(event);
    req.emit('close');
    expect(() => sse.close()).not.toThrow();
    expect(() => sse.close()).not.toThrow();
  });
});
