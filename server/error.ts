/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Global Nitro error handler. Wired via `nitro.errorHandler` in nuxt.config
 * so EVERY API failure — whether thrown via h3 `createError`, an unhandled
 * Promise from a handler, or a bug — passes through here.
 *
 * Behavior:
 *   - All `/api/*` responses become JSON `{ ok: false, code, msg }`.
 *     Stack traces only included in dev (`NODE_ENV !== 'production'`).
 *   - Non-API routes get a minimal plain-text body. The SPA shell only
 *     hits this on truly catastrophic failure (static HTML itself failing);
 *     a JSON-shaped error wouldn't help the browser anyway.
 *   - Every error is forwarded to `logEvent` so the JSONL log is the
 *     single source of truth for diagnostics.
 *
 * Avoid throwing from here — this IS the safety net.
 */

import type { NitroErrorHandler } from 'nitropack';
import { getRequestPath, setResponseHeader, setResponseStatus } from 'h3';
import { logEvent } from './utils/log';

const handler: NitroErrorHandler = (error, event) => {
  const statusCode =
    typeof error.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 500;
  const statusMessage = error.statusMessage || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR');
  const path = (() => {
    try {
      return getRequestPath(event);
    } catch {
      return '';
    }
  })();

  // 4xx is client mistake — log at warn. 5xx is our bug — log at error.
  logEvent({
    level: statusCode >= 500 ? 'error' : 'warn',
    event: 'http_error',
    statusCode,
    code: statusMessage,
    path,
    msg: error.message,
    stack: statusCode >= 500 ? error.stack : undefined,
  });

  const isApi = path.startsWith('/api/');
  const isDev = process.env.NODE_ENV !== 'production';

  setResponseStatus(event, statusCode, statusMessage);

  if (isApi) {
    setResponseHeader(event, 'content-type', 'application/json');
    const body = {
      ok: false,
      code: statusMessage,
      msg: error.message,
      ...(isDev && error.stack ? { stack: error.stack } : {}),
    };
    event.node.res.end(JSON.stringify(body));
    return;
  }

  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8');
  event.node.res.end(`${statusCode} ${statusMessage}\n${error.message}\n`);
};

export default handler;
