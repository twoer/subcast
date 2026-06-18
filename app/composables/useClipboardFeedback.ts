/* SPDX-License-Identifier: Apache-2.0 */
import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';

export interface ClipboardLike {
  writeText: (text: string) => Promise<void>;
}

export interface ClipboardFeedbackOptions {
  clipboard?: ClipboardLike;
  document?: Document;
  resetMs?: number;
}

export function useClipboardFeedback<TKey extends string>(options: ClipboardFeedbackOptions = {}) {
  const copiedKey = ref<TKey | null>(null);
  let resetHandle: ReturnType<typeof setTimeout> | null = null;
  const resetMs = options.resetMs ?? 2_000;

  function clear(): void {
    if (resetHandle) clearTimeout(resetHandle);
    resetHandle = null;
    copiedKey.value = null;
  }

  async function writeText(text: string): Promise<void> {
    const clipboard = options.clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
    try {
      if (!clipboard) throw new Error('clipboard unavailable');
      await clipboard.writeText(text);
      return;
    } catch {
      const doc = options.document ?? (typeof document !== 'undefined' ? document : undefined);
      if (!doc) throw new Error('clipboard unavailable');
      const textarea = doc.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      doc.body.appendChild(textarea);
      textarea.select();
      doc.execCommand('copy');
      doc.body.removeChild(textarea);
    }
  }

  async function copy(key: TKey, text: string): Promise<void> {
    await writeText(text);
    copiedKey.value = key;
    if (resetHandle) clearTimeout(resetHandle);
    resetHandle = setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
      resetHandle = null;
    }, resetMs);
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      clear();
    });
  }

  return { copiedKey, copy, clear };
}
