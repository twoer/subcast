/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Shared {whisperModel, ollamaModel} + readiness flags the AppHeader chip
 * displays.
 *
 * Backed by `useState` so the chip survives page navigations without
 * re-fetching, and so the Settings page (which already round-trips
 * `/api/settings` on save / Use clicks) can `set()` the new names
 * synchronously then `refresh()` to settle readiness.
 *
 * Readiness semantics:
 *   - `whisperReady` / `ollamaReady`: `true` only when the active
 *     model name appears in the installed list. `false` when the
 *     model is configured but missing (the case that motivated this
 *     composable's readiness extension — fresh installs default to
 *     `qwen2.5:7b` but Ollama may not actually have it). `null` means
 *     "unknown" — web mode (no Ollama probe), or the first paint
 *     before `refresh()` settles.
 *   - `ollamaRunning`: mirrors what `/api/desktop/models` reports.
 *     `null` in web mode.
 */

interface ActiveModels {
  whisperModel: string;
  ollamaModel: string;
  whisperReady: boolean | null;
  ollamaReady: boolean | null;
  ollamaRunning: boolean | null;
}

interface SettingsResp {
  settings: { whisperModel: string; ollamaModel: string };
}

interface DesktopModelsResp {
  whisper: { active: string; installed: Array<{ name: string }> };
  ollama: { running: boolean; active: string; installed: Array<{ name: string }> };
}

export function useActiveModels() {
  const data = useState<ActiveModels | null>('subcast:active-models', () => null);
  const desktop = useDesktop();

  async function refreshFromDesktop(): Promise<void> {
    const res = await $fetch<DesktopModelsResp>('/api/desktop/models');
    const whisperInstalled = new Set(res.whisper.installed.map((m) => m.name));
    const ollamaInstalled = new Set(res.ollama.installed.map((m) => m.name));
    data.value = {
      whisperModel: res.whisper.active,
      ollamaModel: res.ollama.active,
      whisperReady: whisperInstalled.has(res.whisper.active),
      ollamaReady: res.ollama.running && ollamaInstalled.has(res.ollama.active),
      ollamaRunning: res.ollama.running,
    };
  }

  async function refreshFromSettings(): Promise<void> {
    const res = await $fetch<SettingsResp>('/api/settings');
    data.value = {
      whisperModel: res.settings.whisperModel,
      ollamaModel: res.settings.ollamaModel,
      whisperReady: null,
      ollamaReady: null,
      ollamaRunning: null,
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
  function set(whisperModel: string, ollamaModel: string): void {
    const prev = data.value;
    const namesChanged =
      !prev || prev.whisperModel !== whisperModel || prev.ollamaModel !== ollamaModel;
    data.value = {
      whisperModel,
      ollamaModel,
      whisperReady: namesChanged ? null : prev?.whisperReady ?? null,
      ollamaReady: namesChanged ? null : prev?.ollamaReady ?? null,
      ollamaRunning: prev?.ollamaRunning ?? null,
    };
  }

  return { data, refresh, set };
}
