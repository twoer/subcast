/* SPDX-License-Identifier: Apache-2.0 */
import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import {
  useRetranscribeAction,
  type RetranscribeFetcher,
} from '../useRetranscribeAction';

describe('useRetranscribeAction', () => {
  it('exposes dialog state', () => {
    const action = useRetranscribeAction(ref('abc123'), {
      fetcher: vi.fn<RetranscribeFetcher>(),
    });

    expect(action.showDialog.value).toBe(false);
    action.showDialog.value = true;
    expect(action.showDialog.value).toBe(true);
    action.showDialog.value = false;
    expect(action.showDialog.value).toBe(false);
  });

  it('posts retry request and reloads on success', async () => {
    const fetcher = vi.fn<RetranscribeFetcher>().mockResolvedValue({});
    const reload = vi.fn();
    const hash = computed(() => 'abc123');

    const action = useRetranscribeAction(hash, { fetcher, reload });
    action.showDialog.value = true;
    await action.confirm();

    expect(fetcher).toHaveBeenCalledWith('/api/transcribe/retry', {
      method: 'POST',
      body: { hash: 'abc123' },
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(action.showDialog.value).toBe(false);
    // running must reset regardless of reload; the contract is "operation
    // finished → not running", not "running stays true until the page is
    // torn down". Guards a future switch from hard reload to SPA navigation.
    expect(action.running.value).toBe(false);
    expect(action.error.value).toBeNull();
  });

  it('resets running even when reload does not unload the page (SPA case)', async () => {
    const fetcher = vi.fn<RetranscribeFetcher>().mockResolvedValue({});
    // No-op reload simulates SPA navigation that reuses the component
    // instance instead of discarding it via window.location.reload().
    const reload = vi.fn();
    const action = useRetranscribeAction(ref('abc123'), { fetcher, reload });
    action.showDialog.value = true;
    await action.confirm();

    expect(action.running.value).toBe(false);
    expect(action.showDialog.value).toBe(false);
  });

  it('stores error state and calls onError when request fails', async () => {
    const fetcher = vi.fn<RetranscribeFetcher>().mockRejectedValue(new Error('retry failed'));
    const onError = vi.fn();

    const action = useRetranscribeAction(ref('abc123'), { fetcher, onError });
    action.showDialog.value = true;
    await action.confirm();

    expect(action.running.value).toBe(false);
    expect(action.showDialog.value).toBe(false);
    expect(action.error.value).toBe('retry failed');
    expect(onError).toHaveBeenCalledWith('retry failed');
  });

  it('uses the legacy fallback message for non-error rejections', async () => {
    const fetcher = vi.fn<RetranscribeFetcher>().mockRejectedValue('nope');
    const onError = vi.fn();

    const action = useRetranscribeAction(ref('abc123'), { fetcher, onError });
    await action.confirm();

    expect(action.error.value).toBe('retranscribe failed');
    expect(onError).toHaveBeenCalledWith('retranscribe failed');
  });
});
