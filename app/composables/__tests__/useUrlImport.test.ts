/* SPDX-License-Identifier: Apache-2.0 */
//
// Regression coverage for the P2.1 fix in
// docs/reviews/2026-06-22-url-import-review.md: `cancel()` must actually
// reach the server (DELETE /api/import-url?jobId=...) so the yt-dlp
// download is stopped, not merely hidden by resetting the local UI.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useUrlImport, type UrlImportOptions } from '../useUrlImport';
import { useUploadStatus } from '../useUploadStatus';

/**
 * Minimal EventSource stub. The composable only uses addEventListener,
 * close, and the implicit constructor; we expose a hook to push synthetic
 * frames into the 'progress' listener so tests can drive onFrame().
 */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  private listeners = new Map<string, Set<(e: { data: string }) => void>>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(event: string, fn: (e: { data: string }) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
  }
  close(): void {
    this.closed = true;
    FakeEventSource.last = null;
  }
  /** Test helper: emit a 'progress' frame to the composable's listener. */
  emitProgress(data: unknown): void {
    const set = this.listeners.get('progress');
    if (!set) return;
    const evt = { data: JSON.stringify(data) };
    for (const fn of set) fn(evt);
  }
}

function makeComposable(overrides: Partial<UrlImportOptions> = {}) {
  const fetcher = vi.fn<NonNullable<UrlImportOptions['fetcher']>>().mockResolvedValue({ jobId: 'job-1' });
  const cancelFetcher = vi.fn<NonNullable<UrlImportOptions['cancelFetcher']>>().mockResolvedValue({
    ok: true,
    canceled: true,
  });
  const navigate = vi.fn();
  const composable = useUrlImport({
    t: (key) => key,
    status: useUploadStatus(),
    fetcher,
    cancelFetcher,
    navigate,
    ...overrides,
  });
  return { composable, fetcher, cancelFetcher, navigate };
}

describe('useUrlImport.cancel (P2.1)', () => {
  beforeEach(() => {
    FakeEventSource.last = null;
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = null;
  });

  it('fires DELETE /api/import-url with the current jobId', async () => {
    const { composable, fetcher, cancelFetcher } = makeComposable();
    await composable.importUrl('https://example.com/a');
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());

    composable.cancel();

    expect(fetcher).toHaveBeenCalledWith('/api/import-url', {
      method: 'POST',
      body: { url: 'https://example.com/a' },
    });
    expect(cancelFetcher).toHaveBeenCalledWith('/api/import-url', {
      method: 'DELETE',
      query: { jobId: 'job-1' },
    });
    expect(composable.phase.value).toBe('idle');
    expect(composable.percent.value).toBe(0);
  });

  it('does not send DELETE when there is no active jobId', () => {
    // No importUrl() yet — cancel() should be a pure local reset.
    const { composable, cancelFetcher } = makeComposable();
    composable.cancel();
    expect(cancelFetcher).not.toHaveBeenCalled();
  });

  it('does not double-cancel after a terminal "canceled" frame', async () => {
    const { composable, cancelFetcher } = makeComposable();
    await composable.importUrl('https://example.com/b');
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());

    // Server-initiated cancel arrives via SSE; onFrame clears currentJobId.
    FakeEventSource.last!.emitProgress({ phase: 'canceled' });
    // Subsequent user click should not fire a second DELETE.
    composable.cancel();

    expect(cancelFetcher).not.toHaveBeenCalled();
  });

  it('does not double-cancel after a terminal "done" frame', async () => {
    const { composable, cancelFetcher } = makeComposable();
    await composable.importUrl('https://example.com/c');
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());

    FakeEventSource.last!.emitProgress({ phase: 'done', hash: 'deadbeef' });
    composable.cancel();

    expect(cancelFetcher).not.toHaveBeenCalled();
  });

  it('swallows DELETE network failures without surfacing to the UI', async () => {
    // cancel() returns void and resets optimistically; a rejected DELETE
    // must not throw an unhandled rejection or overwrite the error banner.
    const cancelFetcher = vi
      .fn<NonNullable<UrlImportOptions['cancelFetcher']>>()
      .mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { composable } = makeComposable({ cancelFetcher });

    await composable.importUrl('https://example.com/d');
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());

    composable.cancel();
    // Let the rejected promise's .catch handler run.
    await new Promise((r) => setImmediate(r));

    expect(composable.phase.value).toBe('idle');
    expect(warn).toHaveBeenCalledWith('url import cancel failed', expect.any(Error));
    warn.mockRestore();
  });
});

describe('useUrlImport.importUrl', () => {
  beforeEach(() => {
    FakeEventSource.last = null;
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.last = null;
  });

  it('rejects non-http(s) schemes before hitting the network', async () => {
    const { composable, fetcher } = makeComposable();
    await composable.importUrl('file:///etc/passwd');
    expect(fetcher).not.toHaveBeenCalled();
    // importUrl() validates scheme before touching phase; the surfaced
    // feedback is the shared error banner, not the inline phase bar.
    expect(composable.phase.value).toBe('idle');
  });

  it('navigates to the player on a terminal done frame', async () => {
    const { composable, navigate } = makeComposable();
    await composable.importUrl('https://example.com/ok');
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());

    FakeEventSource.last!.emitProgress({ phase: 'done', hash: 'abc123' });

    expect(navigate).toHaveBeenCalledWith('/player/abc123');
  });
});
