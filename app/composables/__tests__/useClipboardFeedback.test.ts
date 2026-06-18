/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useClipboardFeedback, type ClipboardLike } from '../useClipboardFeedback';

function fakeDocument() {
  const textarea = {
    value: '',
    style: { cssText: '' },
    select: vi.fn(),
  } as unknown as HTMLTextAreaElement;
  return {
    textarea,
    document: {
      createElement: vi.fn(() => textarea),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
      execCommand: vi.fn(),
    } as unknown as Document,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useClipboardFeedback', () => {
  it('copies through native clipboard and resets feedback', async () => {
    vi.useFakeTimers();
    const clipboard: ClipboardLike = { writeText: vi.fn().mockResolvedValue(undefined) };
    const feedback = useClipboardFeedback<string>({ clipboard, resetMs: 100 });

    await feedback.copy('fix-1', 'command');

    expect(clipboard.writeText).toHaveBeenCalledWith('command');
    expect(feedback.copiedKey.value).toBe('fix-1');

    vi.advanceTimersByTime(100);
    expect(feedback.copiedKey.value).toBeNull();
  });

  it('falls back to a textarea when native clipboard fails', async () => {
    const clipboard: ClipboardLike = { writeText: vi.fn().mockRejectedValue(new Error('denied')) };
    const { document, textarea } = fakeDocument();
    const feedback = useClipboardFeedback<string>({ clipboard, document });

    await feedback.copy('summary', 'markdown');

    expect(document.createElement).toHaveBeenCalledWith('textarea');
    expect(textarea.value).toBe('markdown');
    expect(textarea.select).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(feedback.copiedKey.value).toBe('summary');
  });

  it('clears a previous reset timer when a new key is copied', async () => {
    vi.useFakeTimers();
    const clipboard: ClipboardLike = { writeText: vi.fn().mockResolvedValue(undefined) };
    const feedback = useClipboardFeedback<string>({ clipboard, resetMs: 100 });

    await feedback.copy('a', 'first');
    vi.advanceTimersByTime(50);
    await feedback.copy('b', 'second');
    vi.advanceTimersByTime(50);

    expect(feedback.copiedKey.value).toBe('b');

    vi.advanceTimersByTime(50);
    expect(feedback.copiedKey.value).toBeNull();
  });

  it('can be cleared manually', async () => {
    const clipboard: ClipboardLike = { writeText: vi.fn().mockResolvedValue(undefined) };
    const feedback = useClipboardFeedback<string>({ clipboard });

    await feedback.copy('a', 'first');
    feedback.clear();

    expect(feedback.copiedKey.value).toBeNull();
  });
});
