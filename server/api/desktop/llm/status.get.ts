/* SPDX-License-Identifier: Apache-2.0 */

/**
 * GET /api/desktop/llm/status
 *
 * Returns the LLM model picture the setup wizard / settings panel needs to
 * render: which model is active per persisted settings, which size we'd
 * recommend for the host's RAM, which models are already in the canonical
 * install location, and which models were detected elsewhere on disk
 * (LM Studio, Jan, llama.cpp cache) and could be symlinked / copied in.
 *
 * Also surfaces:
 *   - `totalMemoryGB`  — so the wizard can show an 8 GB low-memory banner
 *     without a second hardware probe round-trip.
 *   - `migrationHint`  — one-shot read+delete of
 *     `<SUBCAST_HOME>/models/llm/.migration-hint.json`, written by
 *     `settings.ts` when an upgrading user's legacy `ollamaModel` field
 *     mapped to a Qwen2.5 tier. The wizard uses this to pre-select the
 *     same tier the user was running before the llama.cpp switch.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createError, defineEventHandler } from 'h3';
import { detectHardware } from '../../../utils/hardware';
import { loadSettings } from '../../../utils/settings';
import { logEvent } from '../../../utils/log';
import { scanLlmModels } from '../../../../desktop/modelManager/llmScan';
import { recommendLlmModel, type LlmModelId } from '#shared/llmModels';
import { llmModelPath } from '../../../../desktop/modelManager/llmInstall';

const VALID_HINT_IDS: ReadonlySet<LlmModelId> = new Set(['3b', '7b', '14b']);

/**
 * Read + delete the one-shot migration hint sidecar written by
 * `settings.ts` for users upgrading from the 0.1 Ollama-backed build.
 *
 * Best-effort: any I/O or parse error returns undefined so the wizard
 * silently falls back to the hardware-tier recommendation. The file is
 * deleted on every successful read so the hint only fires once.
 */
function readAndConsumeMigrationHint(): LlmModelId | undefined {
  const home = process.env.SUBCAST_HOME;
  if (!home) return undefined;
  const file = join(home, 'models', 'llm', '.migration-hint.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { id?: unknown };
    const id = typeof parsed.id === 'string' ? parsed.id : undefined;
    // Delete unconditionally — even malformed hints shouldn't survive
    // to the next request.
    rmSync(file, { force: true });
    return id && VALID_HINT_IDS.has(id as LlmModelId) ? (id as LlmModelId) : undefined;
  } catch (err) {
    logEvent({
      level: 'debug',
      event: 'llm_migration_hint_read_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export default defineEventHandler(async (event) => {
  if (process.env.SUBCAST_DESKTOP !== 'true') {
    throw createError({ statusCode: 404, statusMessage: 'NOT_FOUND' });
  }
  void event;
  const [scan, hw, settings] = await Promise.all([
    scanLlmModels(),
    Promise.resolve(detectHardware()),
    Promise.resolve(loadSettings()),
  ]);
  const tagged = scan.map((m) => ({
    name: m.name,
    path: m.path,
    source: m.source,
    sizeBytes: m.sizeBytes,
    installed: m.path === llmModelPath(m.name),
  }));
  return {
    active: settings.llmModel,
    recommended: recommendLlmModel({ totalMemoryGB: hw.totalMemoryGB }),
    totalMemoryGB: hw.totalMemoryGB,
    migrationHint: readAndConsumeMigrationHint(),
    installed: tagged.filter((m) => m.installed),
    scanned: tagged.filter((m) => !m.installed),
  };
});
