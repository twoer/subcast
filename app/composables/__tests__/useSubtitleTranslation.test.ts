/* SPDX-License-Identifier: Apache-2.0 */
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLangSwitcher } from '../useLangSwitcher';
import { useSubtitleStreams } from '../useSubtitleStreams';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  return {
    ...actual,
    onBeforeUnmount: vi.fn(),
  };
});

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    te: () => true,
  }),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(): void {
    // These tests only assert stream creation.
  }

  close(): void {
    this.closed = true;
  }
}

function setupStreams() {
  const hash = ref('abc123');
  const currentLang = ref('original');
  const forwarded: unknown[] = [];
  const streams = useSubtitleStreams({
    hash,
    currentLang,
    onCueForCurrentLang: (cue) => forwarded.push(cue),
  });
  return { hash, currentLang, forwarded, streams };
}

describe('subtitle translation UI trigger', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the translate SSE endpoint for the selected target language', () => {
    const { streams } = setupStreams();

    streams.openTranslateStream('zh-CN');

    expect(FakeEventSource.instances.map((es) => es.url)).toEqual([
      '/api/translate?hash=abc123&lang=zh-CN',
    ]);
    expect(streams.langStatus.value['zh-CN']).toBe('running');
    expect(streams.translateProgress.value).toBe(0);
  });

  it('language switching starts translation when transcript cues are available', () => {
    const { hash, currentLang, streams } = setupStreams();
    const rebuildTrack = vi.fn();
    const switcher = useLangSwitcher({
      hash,
      currentLang,
      cuesByLang: streams.cuesByLang,
      langStatus: streams.langStatus,
      status: streams.status,
      errMsg: streams.errMsg,
      fromCache: streams.fromCache,
      translateProgress: streams.translateProgress,
      translateRetryNotice: streams.translateRetryNotice,
      transcriptReady: ref(true),
      transcriptNotReadyMessage: 'original-not-ready',
      isStreaming: streams.isStreaming,
      openOriginalStream: streams.openOriginalStream,
      openTranslateStream: streams.openTranslateStream,
      closeStream: streams.closeStream,
      rebuildTrack,
    });

    switcher.onLangChange('zh-CN');

    expect(currentLang.value).toBe('zh-CN');
    expect(rebuildTrack).toHaveBeenCalledWith([]);
    expect(FakeEventSource.instances.map((es) => es.url)).toEqual([
      '/api/translate?hash=abc123&lang=zh-CN',
    ]);
  });

  it('language switching does not start translation before any transcript source is available', () => {
    const { hash, currentLang, streams } = setupStreams();
    const switcher = useLangSwitcher({
      hash,
      currentLang,
      cuesByLang: streams.cuesByLang,
      langStatus: streams.langStatus,
      status: streams.status,
      errMsg: streams.errMsg,
      fromCache: streams.fromCache,
      translateProgress: streams.translateProgress,
      translateRetryNotice: streams.translateRetryNotice,
      transcriptReady: ref(false),
      transcriptNotReadyMessage: 'original-not-ready',
      isStreaming: streams.isStreaming,
      openOriginalStream: streams.openOriginalStream,
      openTranslateStream: streams.openTranslateStream,
      closeStream: streams.closeStream,
      rebuildTrack: vi.fn(),
    });

    switcher.onLangChange('zh-CN');

    expect(currentLang.value).toBe('original');
    expect(streams.errMsg.value).toBe('original-not-ready');
    expect(FakeEventSource.instances).toEqual([]);
  });
});
