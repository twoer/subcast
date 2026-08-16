/* SPDX-License-Identifier: Apache-2.0 */
import { ref, computed, onBeforeUnmount, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';

export interface CueData {
  startMs: number;
  endMs: number;
  text: string;
  chunkIdx?: number;
  quality?: 'ok' | 'suspect';
}

export type LangStatus = 'idle' | 'running' | 'done' | 'error';

export interface UseSubtitleStreamsOptions {
  hash: Ref<string>;
  currentLang: Ref<string>;
  /**
   * Which text layer of the ORIGINAL transcript is displayed:
   * 'original' (raw ASR) or 'polished' (AI-polished layer). Only
   * meaningful when currentLang === 'original'. When 'polished', `cues`
   * and cue-forwarding route to cuesByLang['polished'].
   */
  textVariant?: Ref<'original' | 'polished'>;
  /** Forward cues that belong to the currently-displayed language to the
   *  video element's TextTrack. The composable owns the cue store; the
   *  consumer owns the DOM-side track. */
  onCueForCurrentLang: (cue: CueData) => void;
}

type StreamHandle = { es: EventSource; ac: AbortController };

export function useSubtitleStreams(opts: UseSubtitleStreamsOptions) {
  const { t, te } = useI18n();

  const cuesByLang = ref<Record<string, CueData[]>>({ original: [] });
  const langStatus = ref<Record<string, LangStatus>>({});
  const status = ref<LangStatus>('idle');
  const errMsg = ref<string | null>(null);
  const fromCache = ref(false);
  const translateProgress = ref<number | null>(null);
  const translateRetryNotice = ref(false);
  const polishProgress = ref<number | null>(null);
  /** What produced the original transcript (engine id) + the auto-dispatch
   *  language vote — the player uses these to suggest Whisper when English
   *  content had to fall back to SenseVoice. Set on the transcribe 'done'
   *  frame, for both live runs and cached replays. */
  const transcriptEngine = ref<string | null>(null);
  const transcriptDetectedLang = ref<string | null>(null);

  // The language whose cues are currently displayed: the selected
  // translation, or — for the original — whichever text variant the
  // player toggled to.
  const displayLang = computed(() =>
    opts.currentLang.value === 'original' && opts.textVariant?.value === 'polished'
      ? 'polished'
      : opts.currentLang.value,
  );

  // esByLang is intentionally a plain object: it's never read from a template
  // and reactivity would only add cost. Callers see it via `isStreaming(lang)`.
  const esByLang: Record<string, StreamHandle | null> = {};

  const cues = computed(() => cuesByLang.value[displayLang.value] ?? []);
  const cachedLangs = computed<string[]>(() =>
    Object.entries(langStatus.value)
      .filter(([, st]) => st === 'done')
      .map(([lang]) => lang),
  );

  function isStreaming(lang: string): boolean {
    return !!esByLang[lang];
  }

  function closeStream(lang: string): void {
    const handle = esByLang[lang];
    if (!handle) return;
    handle.ac.abort();
    handle.es.close();
    esByLang[lang] = null;
  }

  function closeAll(): void {
    for (const k of Object.keys(esByLang)) closeStream(k);
  }

  function friendlyError(code: string): string {
    const key = `player.errors.${code}`;
    return te(key) ? t(key) : t('player.errors.fallback');
  }

  function handleSseError(e: Event, lang: string): void {
    const raw = (e as MessageEvent).data;
    let detail = t('player.errors.disconnected');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.code) detail = friendlyError(data.code);
      } catch {
        /* ignore parse error — fall back to disconnected */
      }
    }
    langStatus.value[lang] = 'error';
    if (displayLang.value === lang) {
      errMsg.value = detail;
      status.value = 'error';
    }
  }

  function openOriginalStream(): void {
    if (esByLang.original) return;
    langStatus.value.original = 'running';
    status.value = 'running';
    const ac = new AbortController();
    const es = new EventSource(`/api/transcribe?hash=${opts.hash.value}`);
    esByLang.original = { es, ac };
    const sigOpts = { signal: ac.signal };

    es.addEventListener('status', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (data.fromCache) fromCache.value = true;
      if (displayLang.value === 'original') status.value = 'running';
    }, sigOpts);
    es.addEventListener('cue', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as CueData;
      // Initial state seeds `original: []`, but be explicit so a future
      // refactor that mutates cuesByLang elsewhere can't silently drop cues
      // (the previous `?.push()` would no-op without warning).
      const arr = cuesByLang.value.original ?? (cuesByLang.value.original = []);
      arr.push(data);
      if (displayLang.value === 'original') opts.onCueForCurrentLang(data);
    }, sigOpts);
    es.addEventListener('done', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { engine?: string; detectedLang?: string | null };
      if (typeof data.engine === 'string') transcriptEngine.value = data.engine;
      if ('detectedLang' in data) transcriptDetectedLang.value = data.detectedLang ?? null;
      langStatus.value.original = 'done';
      if (displayLang.value === 'original') status.value = 'done';
      closeStream('original');
    }, sigOpts);
    es.addEventListener('error', (e) => {
      handleSseError(e, 'original');
      closeStream('original');
    }, sigOpts);
  }

  function openTranslateStream(lang: string): void {
    if (esByLang[lang]) return;
    langStatus.value[lang] = 'running';
    if (displayLang.value === lang) status.value = 'running';
    cuesByLang.value[lang] = cuesByLang.value[lang] ?? [];
    translateProgress.value = 0;
    if (displayLang.value === lang) translateRetryNotice.value = false;

    const ac = new AbortController();
    const es = new EventSource(`/api/translate?hash=${opts.hash.value}&lang=${lang}`);
    esByLang[lang] = { es, ac };
    const sigOpts = { signal: ac.signal };

    es.addEventListener('status', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (data.fromCache && displayLang.value === lang) fromCache.value = true;
    }, sigOpts);
    es.addEventListener('batch-progress', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (displayLang.value === lang) translateProgress.value = data.progressPct;
    }, sigOpts);
    es.addEventListener('cue-translated', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      // openTranslateStream seeds cuesByLang.value[lang] above before opening
      // the EventSource, so this is normally a no-op fallback. Keeping it
      // explicit avoids the `!` non-null assertion (which would lie to TS
      // if a future refactor cleared the map between init and first cue).
      const arr = cuesByLang.value[lang] ?? (cuesByLang.value[lang] = []);
      for (const c of data.cues as CueData[]) arr.push(c);
      if (displayLang.value === lang) {
        translateRetryNotice.value = false;
        for (const c of data.cues as CueData[]) opts.onCueForCurrentLang(c);
      }
    }, sigOpts);
    es.addEventListener('batch-retry', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (displayLang.value === lang) translateRetryNotice.value = true;
      console.warn('translate batch-retry', data);
    }, sigOpts);
    es.addEventListener('done', () => {
      langStatus.value[lang] = 'done';
      translateProgress.value = null;
      translateRetryNotice.value = false;
      if (displayLang.value === lang) status.value = 'done';
      closeStream(lang);
    }, sigOpts);
    es.addEventListener('error', (e) => {
      translateRetryNotice.value = false;
      handleSseError(e, lang);
      closeStream(lang);
    }, sigOpts);
  }

  /**
   * Open (or replay) the AI-polished layer. Server replays cached
   * results, so this doubles as the loader when the player's variant
   * toggle switches to 'polished' for an already-polished video.
   */
  function openPolishStream(): void {
    if (esByLang.polished) return;
    langStatus.value.polished = 'running';
    cuesByLang.value.polished = cuesByLang.value.polished ?? [];
    polishProgress.value = 0;

    const ac = new AbortController();
    const es = new EventSource(`/api/polish?hash=${opts.hash.value}`);
    esByLang.polished = { es, ac };
    const sigOpts = { signal: ac.signal };

    es.addEventListener('status', () => {
      if (displayLang.value === 'polished') status.value = 'running';
    }, sigOpts);
    es.addEventListener('batch-progress', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      polishProgress.value = data.progressPct;
    }, sigOpts);
    es.addEventListener('cue-polished', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const arr = cuesByLang.value.polished ?? (cuesByLang.value.polished = []);
      for (const c of data.cues as CueData[]) arr.push(c);
      if (displayLang.value === 'polished') {
        for (const c of data.cues as CueData[]) opts.onCueForCurrentLang(c);
      }
    }, sigOpts);
    es.addEventListener('done', () => {
      langStatus.value.polished = 'done';
      polishProgress.value = null;
      if (displayLang.value === 'polished') status.value = 'done';
      closeStream('polished');
    }, sigOpts);
    es.addEventListener('error', (e) => {
      // Unlike translation (whose failures only matter for the language
      // being viewed), polish is always user-initiated or toggled —
      // surface the failure regardless of the current display layer.
      const raw = (e as MessageEvent).data;
      let detail = t('player.errors.disconnected');
      if (raw) {
        try {
          const data = JSON.parse(raw);
          if (data.code) detail = friendlyError(data.code);
        } catch {
          /* fall back to disconnected */
        }
      }
      langStatus.value.polished = 'error';
      errMsg.value = detail;
      polishProgress.value = null;
      closeStream('polished');
    }, sigOpts);
  }

  async function loadCachedLangs(): Promise<void> {
    try {
      const res = await $fetch<{
        items: Array<{ sha256: string; langs: string[]; hasPolished: boolean }>;
      }>('/api/cache/list');
      const entry = res.items.find((i) => i.sha256 === opts.hash.value);
      if (!entry) return;
      for (const lang of entry.langs) {
        if (lang === 'original') continue;
        if (langStatus.value[lang]) continue; // don't clobber active session state
        langStatus.value[lang] = 'done';
      }
      // Mark the polish layer as available; its cues load lazily via
      // openPolishStream() when the variant toggle first switches over.
      if (entry.hasPolished && !langStatus.value.polished) {
        langStatus.value.polished = 'done';
      }
    } catch {
      /* network blip — dropdown just won't show pre-marks */
    }
  }

  onBeforeUnmount(closeAll);

  return {
    cuesByLang,
    cues,
    langStatus,
    status,
    errMsg,
    fromCache,
    translateProgress,
    translateRetryNotice,
    polishProgress,
    transcriptEngine,
    transcriptDetectedLang,
    cachedLangs,
    isStreaming,
    openOriginalStream,
    openTranslateStream,
    openPolishStream,
    closeStream,
    closeAll,
    loadCachedLangs,
  };
}
