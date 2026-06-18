/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Race two model-mirror URLs and pick whichever delivers bytes the
 * fastest in a 2-second probe window. Sits on top of the same `fetch`
 * primitive the existing `downloader.ts` uses — the winner URL gets
 * handed back to `downloadFile()` so resume / hash-verify / cancel
 * paths are entirely unchanged.
 */

export interface ProbeOptions {
  /**
   * Default 4000ms. Probe runs for this long, then aborts.
   *
   * Raised from 2000ms after CN users hit "no usable source" because
   * hf-mirror.com → cas-bridge.xethub.hf.co redirect dance ate ~1s of
   * DNS + TLS handshake, leaving < 1s to collect 256KB. 4s gives the
   * CDN time to spin up cold connections.
   */
  probeMs?: number;
  /**
   * Minimum bytes to trust the measurement. Default 128KB.
   *
   * Lowered from 256KB: with the 4s probeMs, even slow but usable
   * mirrors (≥ 32KB/s) clear the bar. Below this means the source is
   * effectively dead and shouldn't win the race.
   */
  minBytes?: number;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Injected fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

const DEFAULT_PROBE_MS = 4000;
const DEFAULT_MIN_BYTES = 128 * 1024;

/**
 * Open a Range GET on `url`, read body chunks until either the probe
 * window elapses or the server closes, then return bytes/sec. Returns
 * 0 (not throws) when the source delivered < `minBytes` — too noisy
 * to call a winner. Throws on HTTP errors or aborted-before-start.
 */
export async function probeUrlThroughput(url: string, opts: ProbeOptions = {}): Promise<number> {
  const probeMs = opts.probeMs ?? DEFAULT_PROBE_MS;
  const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const ctrl = new AbortController();
  const onParentAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener('abort', onParentAbort);
  if (opts.signal?.aborted) ctrl.abort();

  let bytes = 0;
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      headers: { Range: 'bytes=0-' },
      signal: ctrl.signal,
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`probe failed: ${res.status} ${res.statusText} for ${url}`);
    }
    if (!res.body) {
      throw new Error(`probe failed: empty body for ${url}`);
    }
    const reader = res.body.getReader();
    while (true) {
      if (Date.now() - start >= probeMs) break;
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    // Best-effort cancel of the in-flight stream.
    ctrl.abort();
  } catch (err) {
    opts.signal?.removeEventListener('abort', onParentAbort);
    if ((err as Error).name !== 'AbortError') throw err;
    // AbortError has two sources: our own probe-window timeout (the
    // happy path — fall through to the bytes-based return below) or
    // the caller's signal firing (user hit cancel — propagate so the
    // wizard sees a real "canceled" instead of a generic "no usable
    // source" thrown later by pickFastestUrl).
    if (opts.signal?.aborted) throw err;
  } finally {
    opts.signal?.removeEventListener('abort', onParentAbort);
  }

  if (bytes < minBytes) return 0;
  const elapsedMs = Math.max(1, Date.now() - start);
  return (bytes * 1000) / elapsedMs;
}

export interface PickFastestResult {
  winner: string;
  /** All probed URLs and their measured bytes/sec (0 when too slow or failed). */
  measurements: Array<{ url: string; bytesPerSecond: number; error?: string }>;
}

/**
 * Fan out probes across `urls` in parallel and return whichever URL
 * delivered the most bytes/sec. URLs that throw, return 0, or take
 * longer than probeMs+slack are silently dropped from contention; the
 * winner is picked from the survivors. Throws only when *every* URL
 * is unusable so the caller can fall through to its normal error
 * handling instead of receiving an arbitrary "winner".
 */
export async function pickFastestUrl(
  urls: readonly string[],
  opts: ProbeOptions = {},
): Promise<string> {
  const result = await pickFastestUrlWithDetail(urls, opts);
  return result.winner;
}

/**
 * Same as `pickFastestUrl` but also returns each candidate's measured
 * throughput so the caller can log the race outcome for support
 * diagnostics.
 */
export async function pickFastestUrlWithDetail(
  urls: readonly string[],
  opts: ProbeOptions = {},
): Promise<PickFastestResult> {
  if (urls.length === 0) throw new Error('pickFastestUrl: no URLs');

  const settled = await Promise.allSettled(
    urls.map((u) => probeUrlThroughput(u, opts)),
  );

  const measurements = settled.map((r, i) => ({
    url: urls[i]!,
    bytesPerSecond: r.status === 'fulfilled' ? r.value : 0,
    error: r.status === 'rejected' ? String((r.reason as Error)?.message ?? r.reason) : undefined,
  }));

  let best: { url: string; bytesPerSecond: number } | null = null;
  for (const m of measurements) {
    if (m.bytesPerSecond > 0 && (best === null || m.bytesPerSecond > best.bytesPerSecond)) {
      best = { url: m.url, bytesPerSecond: m.bytesPerSecond };
    }
  }
  if (!best) {
    throw new Error(
      `pickFastestUrl: no usable source (tried ${urls.length}, all failed or below threshold)`,
    );
  }
  return { winner: best.url, measurements };
}
