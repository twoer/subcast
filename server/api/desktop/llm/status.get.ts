/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * GET /api/desktop/llm/status
 *
 * Returns the LLM model picture the setup wizard / settings panel needs to
 * render: which model is active per persisted settings, which size we'd
 * recommend for the host's RAM, which models are already in the canonical
 * install location, and which models were detected elsewhere on disk
 * (LM Studio, Jan, llama.cpp cache) and could be symlinked / copied in.
 */

import { createError, defineEventHandler } from 'h3';
import { detectHardware } from '../../../utils/hardware';
import { loadSettings } from '../../../utils/settings';
import { scanLlmModels } from '../../../../desktop/modelManager/llmScan';
import { recommendLlmModel } from '../../../../desktop/modelManager/llmConfig';
import { llmModelPath } from '../../../../desktop/modelManager/llmInstall';

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
    installed: tagged.filter((m) => m.installed),
    scanned: tagged.filter((m) => !m.installed),
  };
});
