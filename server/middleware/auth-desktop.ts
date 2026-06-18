/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Desktop-mode API auth (decision 4).
 *
 * Web/dev mode: pass-through (no token check). Web is served on
 * 0.0.0.0:3000 deliberately so LAN demos work; auth here would just be
 * theatre.
 *
 * Desktop mode (`SUBCAST_DESKTOP=true` set by main process before
 * importing Nitro): every request except `/api/health` must carry a
 * matching `x-subcast-token` header. The token is per-session — main
 * process generates a fresh UUID on each launch and injects it through
 * Electron's `webRequest.onBeforeSendHeaders`. Renderer code never
 * receives or stores the token.
 *
 * This blocks same-machine attackers (other apps / browser extensions /
 * rogue scripts) from poking the local API. Remote attackers are already
 * blocked because Nitro binds to 127.0.0.1 in desktop mode.
 */

import { defineEventHandler, getHeader, createError, getRequestPath } from 'h3';

export default defineEventHandler((event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') return;

  // Allow health probes to pass without token — used by Nitro startup
  // readiness check in main process before the token is even injected
  // into the renderer.
  const path = getRequestPath(event);
  if (path === '/api/health') return;

  // Static SPA assets and the SPA shell don't need token auth.
  if (!path.startsWith('/api/')) return;

  const expected = process.env.SUBCAST_API_TOKEN;
  const got = getHeader(event, 'x-subcast-token');
  if (!expected || got !== expected) {
    throw createError({
      statusCode: 401,
      statusMessage: 'BAD_TOKEN',
    });
  }
});
