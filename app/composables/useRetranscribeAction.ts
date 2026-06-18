/* SPDX-License-Identifier: Apache-2.0 */
import { ref, unref, type ComputedRef, type Ref } from 'vue';

export type RetranscribeFetcher = (
  request: string,
  options: { method: 'POST'; body: { hash: string } },
) => Promise<unknown>;

export interface RetranscribeActionOptions {
  fetcher?: RetranscribeFetcher;
  reload?: () => void;
  onError?: (message: string) => void;
}

export function useRetranscribeAction(
  hash: Ref<string> | ComputedRef<string>,
  options?: RetranscribeActionOptions,
) {
  const showDialog = ref(false);
  const running = ref(false);
  const error = ref<string | null>(null);
  const fetcher: RetranscribeFetcher = options?.fetcher ?? ($fetch as unknown as RetranscribeFetcher);

  function reloadPage(): void {
    if (options?.reload) {
      options.reload();
      return;
    }
    if (typeof window !== 'undefined') window.location.reload();
  }

  async function confirm(): Promise<void> {
    running.value = true;
    error.value = null;
    try {
      await fetcher('/api/transcribe/retry', {
        method: 'POST',
        body: { hash: unref(hash) },
      });
      // Hard reload flushes cached cues, streams, and insight state.
      reloadPage();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'retranscribe failed';
      error.value = message;
      options?.onError?.(message);
    } finally {
      // Reset running here (not only in catch) so the flag is always cleared
      // even if reloadPage() is ever switched from a hard window reload to
      // in-app navigation that reuses this component instance.
      running.value = false;
      showDialog.value = false;
    }
  }

  return { showDialog, running, error, confirm };
}
