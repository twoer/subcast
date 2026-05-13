/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * POST /api/desktop/ollama/fix-key
 *
 * Generates `~/.ollama/id_ed25519` if Ollama's identity key file is
 * missing. This is the workaround for the well-known Ollama bug where
 * `ollama pull` against ollama.com's registry fails with
 *
 *     pull model manifest: open ~/.ollama/id_ed25519: no such file or directory
 *
 * The key is normally created by `ollama serve` on first run, but if the
 * user wiped `~/.ollama/` (or installed Ollama via an installer that
 * didn't start serve), it never gets regenerated and pulls keep failing.
 *
 * Idempotent: if the key already exists, returns ok without touching it.
 * Uses macOS / BSD's bundled `ssh-keygen` (always present on darwin).
 *
 * Desktop-only; auth via the session-token middleware like every other
 * /api/desktop/ route.
 */

import { createError, defineEventHandler } from 'h3';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  void event;

  const ollamaDir = join(homedir(), '.ollama');
  const keyPath = join(ollamaDir, 'id_ed25519');

  if (existsSync(keyPath)) {
    return { ok: true, alreadyExists: true, keyPath };
  }

  try {
    await mkdir(ollamaDir, { recursive: true });
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: 'MKDIR_FAILED',
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  try {
    // -t ed25519 — Ollama's expected key type
    // -N ''      — no passphrase
    // -f keyPath — output to the canonical location (also creates .pub sibling)
    // -C subcast — a comment so users tracing the key know it came from us
    await execFileAsync('ssh-keygen', [
      '-t', 'ed25519',
      '-N', '',
      '-f', keyPath,
      '-C', 'subcast-fix',
    ]);
  } catch (err) {
    throw createError({
      statusCode: 500,
      statusMessage: 'KEYGEN_FAILED',
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  return { ok: true, generated: true, keyPath };
});
