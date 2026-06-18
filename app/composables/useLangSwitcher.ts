/* SPDX-License-Identifier: Apache-2.0 */
import { ref, type Ref } from 'vue';
import type { CueData, LangStatus } from './useSubtitleStreams';

export interface UseLangSwitcherOptions {
  hash: Ref<string>;
  currentLang: Ref<string>;
  // From useSubtitleStreams
  cuesByLang: Ref<Record<string, CueData[]>>;
  langStatus: Ref<Record<string, LangStatus>>;
  status: Ref<LangStatus>;
  errMsg: Ref<string | null>;
  fromCache: Ref<boolean>;
  translateProgress: Ref<number | null>;
  translateRetryNotice: Ref<boolean>;
  transcriptReady: Ref<boolean>;
  transcriptNotReadyMessage: string;
  isStreaming: (lang: string) => boolean;
  openOriginalStream: () => void;
  openTranslateStream: (lang: string) => void;
  closeStream: (lang: string) => void;
  // From useSubtitleTrack
  rebuildTrack: (cues: readonly CueData[]) => void;
}

interface QueueListItem {
  kind: 'transcribe' | 'translate';
  id: string;
  videoSha: string;
  targetLang?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
}

/**
 * Orchestrates language switching: updates `currentLang`, rebuilds the
 * video TextTrack, opens the right stream if cues aren't cached, and
 * exposes the cancel/retry actions for the current language.
 */
export function useLangSwitcher(opts: UseLangSwitcherOptions) {
  const showCancelDialog = ref(false);

  async function cancelTranslation(): Promise<void> {
    showCancelDialog.value = false;
    const lang = opts.currentLang.value;
    if (!lang || lang === 'original') return;
    try {
      const res = await $fetch<{ items: QueueListItem[] }>('/api/queue/list');
      const task = res.items.find(
        (i) =>
          i.kind === 'translate'
          && i.videoSha === opts.hash.value
          && i.targetLang === lang
          && (i.status === 'running' || i.status === 'queued'),
      );
      if (task) {
        await $fetch(`/api/queue/translate/${task.id}`, { method: 'DELETE' });
      }
    } catch {
      /* server-side cancel may fail; still tear down client state */
    }
    opts.closeStream(lang);
    opts.translateProgress.value = null;
    opts.translateRetryNotice.value = false;
    opts.langStatus.value[lang] = 'idle';
    if (opts.currentLang.value === lang) opts.status.value = 'idle';
  }

  function retryCurrentLang(): void {
    const lang = opts.currentLang.value;
    if (!lang) return;
    opts.errMsg.value = null;
    opts.translateRetryNotice.value = false;
    if (lang !== 'original' && !opts.transcriptReady.value) {
      opts.errMsg.value = opts.transcriptNotReadyMessage;
      return;
    }
    opts.status.value = 'idle';
    opts.langStatus.value[lang] = 'idle';
    if (lang === 'original') opts.openOriginalStream();
    else opts.openTranslateStream(lang);
  }

  function onLangChange(newLang: string): void {
    if (newLang === opts.currentLang.value) return;
    opts.errMsg.value = null;
    opts.translateRetryNotice.value = false;
    opts.fromCache.value = false;

    if (newLang !== 'original' && !opts.transcriptReady.value) {
      opts.errMsg.value = opts.transcriptNotReadyMessage;
      return;
    }

    opts.currentLang.value = newLang;
    opts.rebuildTrack(opts.cuesByLang.value[newLang] ?? []);
    opts.status.value = opts.langStatus.value[newLang] ?? 'idle';

    if (newLang === 'original') {
      if (
        (opts.cuesByLang.value.original?.length ?? 0) === 0
        && !opts.isStreaming('original')
      ) {
        opts.openOriginalStream();
      }
      return;
    }

    const cached = opts.cuesByLang.value[newLang];
    const needFreshStream
      = !cached
      || cached.length === 0
      || (opts.langStatus.value[newLang] !== 'done' && !opts.isStreaming(newLang));
    if (needFreshStream) opts.openTranslateStream(newLang);
  }

  return {
    showCancelDialog,
    cancelTranslation,
    retryCurrentLang,
    onLangChange,
  };
}
