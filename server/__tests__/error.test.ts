/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createError } from 'h3';
import errorHandler from '../error';

/**
 * Build a minimal H3Event-shaped object good enough for the handler:
 * it only touches `event.node.req.url` (via getRequestPath) and the
 * ServerResponse helpers (setResponseStatus / setResponseHeader /
 * event.node.res.end).
 */
function makeEvent(path: string): {
  event: Parameters<typeof errorHandler>[1];
  getStatus: () => number;
  getStatusMessage: () => string;
  getHeaders: () => Record<string, unknown>;
  getBody: () => string;
} {
  const req = new IncomingMessage(new Socket());
  req.url = path;
  req.method = 'GET';

  const res = new ServerResponse(req);
  let body = '';
  const origEnd = res.end.bind(res);
  res.end = ((chunk?: string | Buffer) => {
    if (chunk !== undefined) body += chunk.toString();
    return origEnd();
  }) as typeof res.end;

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: { node: { req, res }, path } as any,
    getStatus: () => res.statusCode,
    getStatusMessage: () => res.statusMessage,
    getHeaders: () => res.getHeaders(),
    getBody: () => body,
  };
}

describe('Nitro error handler', () => {
  it('renders JSON for /api/* errors with statusCode + code + msg', async () => {
    const { event, getStatus, getBody, getHeaders } = makeEvent('/api/foo');
    const err = createError({ statusCode: 404, statusMessage: 'NOT_FOUND', message: 'thing missing' });
    await errorHandler(err, event);
    expect(getStatus()).toBe(404);
    expect(String(getHeaders()['content-type'])).toContain('application/json');
    const body = JSON.parse(getBody());
    expect(body.ok).toBe(false);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.msg).toBe('thing missing');
  });

  it('coerces unknown statusCode to 500 INTERNAL_ERROR', async () => {
    const { event, getStatus, getBody } = makeEvent('/api/oops');
    await errorHandler(new Error('boom') as Parameters<typeof errorHandler>[0], event);
    expect(getStatus()).toBe(500);
    const body = JSON.parse(getBody());
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.msg).toBe('boom');
  });

  it('includes stack in dev, omits in production', async () => {
    const prevEnv = process.env.NODE_ENV;
    try {
      // Dev: stack present
      process.env.NODE_ENV = 'development';
      const dev = makeEvent('/api/x');
      const e1 = new Error('dev-stack') as Parameters<typeof errorHandler>[0];
      await errorHandler(e1, dev.event);
      expect(JSON.parse(dev.getBody()).stack).toBeTypeOf('string');

      // Prod: stack absent
      process.env.NODE_ENV = 'production';
      const prod = makeEvent('/api/x');
      const e2 = new Error('prod-stack') as Parameters<typeof errorHandler>[0];
      await errorHandler(e2, prod.event);
      expect(JSON.parse(prod.getBody()).stack).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('returns plain text for non-API routes', async () => {
    const { event, getStatus, getBody, getHeaders } = makeEvent('/some-page');
    await errorHandler(
      createError({ statusCode: 500, statusMessage: 'BAD' }),
      event,
    );
    expect(getStatus()).toBe(500);
    expect(String(getHeaders()['content-type'])).toContain('text/plain');
    expect(getBody()).toContain('500');
    expect(getBody()).toContain('BAD');
  });

  it('survives a broken getRequestPath (event without node.req.url)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = { node: { req: {} as IncomingMessage, res: new ServerResponse({} as IncomingMessage) } } as any;
    // Should not throw — fall through to non-API plain-text branch.
    await errorHandler(new Error('x') as Parameters<typeof errorHandler>[0], event);
    expect(event.node.res.statusCode).toBe(500);
  });
});
