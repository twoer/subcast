/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * DELETE /api/desktop/ollama/:name
 *
 * Removes an Ollama-managed model via the Ollama daemon's own delete
 * endpoint. Refuses with 409 if the model is currently set as active in
 * settings.
 */

import { createError, defineEventHandler, getRouterParam } from 'h3';

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';

// NOTE: this endpoint targets the legacy Ollama daemon and will be
// deleted in a later 0.2 task once the Models tab no longer references
// `/api/desktop/ollama/*`. The 0.1 IS_ACTIVE guard (which compared the
// requested tag to `settings.ollamaModel`) is gone — `SubcastSettings`
// now only tracks the new bundled-llama tier id, not arbitrary Ollama
// tags, so there is no equivalent check to make here.
export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }

  const name = getRouterParam(event, 'name');
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'BAD_NAME' });
  }

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'OLLAMA_UNREACHABLE' });
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw createError({ statusCode: 404, statusMessage: 'NOT_INSTALLED' });
    }
    const text = await res.text().catch(() => '');
    throw createError({
      statusCode: 502,
      statusMessage: `OLLAMA_${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    });
  }

  return { deleted: name };
});
