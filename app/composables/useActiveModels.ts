/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Shared {whisperModel, llmModel} + readiness flags the AppHeader chip
 * displays.
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
 *   - Unlike the Ollama-backed 0.1 build, there is no separate
 *     "runtime not started" state for the LLM: llama-server is an
 *     in-process binary spawned on demand, so installed ↔ ready.
 */

import type { LlmModelId } from '#shared/llmModels';

interface ActiveModels {
  whisperModel: string;
  llmModel: LlmModelId | undefined;
  whisperReady: boolean | null;
  llmReady: boolean | null;
}

interface SettingsResp {
  settings: { whisperModel: string; llmModel: LlmModelId | undefined };
}

interface DesktopModelsResp {
  whisper: { active: string; installed: Array<{ name: string }> };
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
    data.value = {
      whisperModel: res.whisper.active,
      llmModel: active,
      whisperReady: whisperInstalled.has(res.whisper.active),
      llmReady: active !== undefined && llmInstalled.has(active),
    };
  }

  async function refreshFromSettings(): Promise<void> {
    const res = await $fetch<SettingsResp>('/api/settings');
    data.value = {
      whisperModel: res.settings.whisperModel,
      llmModel: res.settings.llmModel,
      whisperReady: null,
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
  function set(whisperModel: string, llmModel: LlmModelId | undefined): void {
    const prev = data.value;
    const namesChanged =
      !prev || prev.whisperModel !== whisperModel || prev.llmModel !== llmModel;
    data.value = {
      whisperModel,
      llmModel,
      whisperReady: namesChanged ? null : prev?.whisperReady ?? null,
      llmReady: namesChanged ? null : prev?.llmReady ?? null,
    };
  }

  return { data, refresh, set };
}
