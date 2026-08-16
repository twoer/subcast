/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared {transcribeEngine, whisperModel, llmModel} + readiness flags
 * the AppHeader chip displays.
 *
 * Backed by `useState` so the chip survives page navigations without
 * re-fetching, and so the Settings page (which already round-trips
 * `/api/settings` on save / Use clicks) can `set()` the new names
 * synchronously then `refresh()` to settle readiness.
 *
 * Readiness semantics:
 *   - `whisperReady` / `llmReady`: `true` only when the active
 *     model name appears in the installed list. `false` when the
 *     model is configured but missing (fresh installs default to
 *     no LLM at all, and the user has to download one from the
 *     setup wizard / Models tab). `null` means "unknown" — web mode
 *     (no llm scan), or the first paint before `refresh()` settles.
 *   - `senseVoiceReady`: single fixed model — `true`/`false` from the
 *     desktop models aggregate, `null` in web mode.
 *   - The chip's first slot shows the ACTIVE engine: SenseVoice when
 *     `transcribeEngine === 'sensevoice'` (readiness from
 *     `senseVoiceReady`), otherwise the whisper tier name.
 *   - Unlike the Ollama-backed 0.1 build, there is no separate
 *     "runtime not started" state for the LLM: llama-server is an
 *     in-process binary spawned on demand, so installed ↔ ready.
 */

import type { LlmModelId } from '#shared/llmModels';
import type { TranscribeEngine } from '@/types/settings';

interface ActiveModels {
  transcribeEngine: TranscribeEngine;
  whisperModel: string;
  llmModel: LlmModelId | undefined;
  whisperReady: boolean | null;
  senseVoiceReady: boolean | null;
  llmReady: boolean | null;
}

interface SettingsResp {
  settings: {
    whisperModel: string;
    transcribeEngine?: TranscribeEngine;
    llmModel: LlmModelId | undefined;
  };
}

interface DesktopModelsResp {
  transcribeEngine?: TranscribeEngine;
  whisper: { active: string; installed: Array<{ name: string }> };
  sensevoice?: { ready: boolean };
  llm: { active: LlmModelId | undefined; installed: Array<{ name: LlmModelId }> };
}

export function useActiveModels() {
  const data = useState<ActiveModels | null>('subcast:active-models', () => null);
  const desktop = useDesktop();

  async function refreshFromDesktop(): Promise<void> {
    const res = await $fetch<DesktopModelsResp>('/api/desktop/models');
    const whisperInstalled = new Set(res.whisper.installed.map((m) => m.name));
    const llmInstalled = new Set(res.llm.installed.map((m) => m.name));
    const active = res.llm.active;
    const engine = res.transcribeEngine ?? 'auto';
    const svReady = res.sensevoice?.ready ?? null;
    const anyWhisper = res.whisper.installed.length > 0;
    data.value = {
      transcribeEngine: engine,
      whisperModel: res.whisper.active,
      senseVoiceReady: svReady,
      // `auto` dispatches per audio — ready when either engine is usable.
      // Exposed as whisperReady so the chip warns only when BOTH are out.
      whisperReady: engine === 'auto' ? (svReady === true || anyWhisper) : whisperInstalled.has(res.whisper.active),
      llmModel: active,
      llmReady: active !== undefined && llmInstalled.has(active),
    };
  }

  async function refreshFromSettings(): Promise<void> {
    const res = await $fetch<SettingsResp>('/api/settings');
    data.value = {
      transcribeEngine: res.settings.transcribeEngine ?? 'auto',
      whisperModel: res.settings.whisperModel,
      // Readiness is unknown in web mode (no models scan endpoint).
      whisperReady: null,
      senseVoiceReady: null,
      llmModel: res.settings.llmModel,
      llmReady: null,
    };
  }

  async function refresh(): Promise<void> {
    try {
      if (desktop.isDesktop) {
        await refreshFromDesktop();
      } else {
        await refreshFromSettings();
      }
    } catch {
      /* keep last value — header chip stays stable on transient failures */
    }
  }

  /**
   * Synchronous name update so the chip reflects a Settings-page "Use"
   * click immediately. Readiness is left null (unknown) when names
   * change — caller should follow up with `refresh()` to resolve it
   * against the installed-models endpoint.
   */
  function set(
    whisperModel: string,
    llmModel: LlmModelId | undefined,
    transcribeEngine?: TranscribeEngine,
  ): void {
    const prev = data.value;
    const engine = transcribeEngine ?? prev?.transcribeEngine ?? 'auto';
    const namesChanged =
      !prev
      || prev.whisperModel !== whisperModel
      || prev.llmModel !== llmModel
      || prev.transcribeEngine !== engine;
    data.value = {
      transcribeEngine: engine,
      whisperModel,
      llmModel,
      whisperReady: namesChanged ? null : prev?.whisperReady ?? null,
      senseVoiceReady: namesChanged ? null : prev?.senseVoiceReady ?? null,
      llmReady: namesChanged ? null : prev?.llmReady ?? null,
    };
  }

  return { data, refresh, set };
}
