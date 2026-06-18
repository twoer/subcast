// SPDX-License-Identifier: Apache-2.0
/**
 * Shared fetch wrapper with a hard timeout, used by the sidecar/model
 * fetch scripts (fetch-silero-vad, fetch-diarize-models, fetch-llama-server).
 *
 * Why: those scripts download from GitHub releases / HuggingFace. A bare
 * fetch() with no timeout will hang forever if the connection stalls
 * (observed on GitHub-hosted runners: the windows build sat in
 * fetch-* for 30+ minutes before being manually cancelled). The runner
 * has a 6h hard cap, so a stalled fetch effectively wedges the whole
 * release until then.
 *
 * Default 5 min covers the largest asset (~tens of MB) on a slow link
 * while still failing fast on a truly stuck connection. Override per
 * call via the second arg.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: 'follow', signal: controller.signal });
    return res;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`download timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
