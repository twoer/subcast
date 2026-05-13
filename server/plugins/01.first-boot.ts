/* SPDX-License-Identifier: AGPL-3.0-or-later */
// First-boot bootstrap: write defaults into the settings table the first
// time the app runs.
//
//   * Web mode  — keep the original hardware-tier recommendation; web
//                 devs have whatever models they manually pulled, and
//                 the home health banner surfaces mismatches.
//   * Desktop   — boot with a conservative pair (base + qwen2.5:7b) so
//                 the setup wizard's first-run check doesn't end up
//                 pointing at a model the user hasn't installed yet.
//                 The wizard then writes the user's actual choice
//                 (`persistWhisperChoice` / `persistQwenChoice` on
//                 Step 1 / Step 3 "Next") and overrides the default.
// Honors SUBCAST_OLLAMA_MODEL env override either way for dev workflows.
import { detectHardware } from '../utils/hardware';
import { isFirstBoot, saveSettings } from '../utils/settings';

const DESKTOP_SAFE_DEFAULTS = {
  whisperModel: 'base' as const,
  ollamaModel: 'qwen2.5:7b' as const,
};

export default defineNitroPlugin(() => {
  if (!isFirstBoot()) return;
  const desktop = process.env.SUBCAST_DESKTOP === 'true';
  const hw = detectHardware();
  const ollamaOverride = process.env.SUBCAST_OLLAMA_MODEL;

  const defaults = desktop
    ? DESKTOP_SAFE_DEFAULTS
    : { whisperModel: hw.recommended.whisperModel, ollamaModel: hw.recommended.ollamaModel };

  saveSettings({
    whisperModel: defaults.whisperModel,
    ollamaModel: ollamaOverride && ollamaOverride.length > 0
      ? ollamaOverride
      : defaults.ollamaModel,
  });

  console.log(
    `[subcast] first-boot defaults (${desktop ? 'desktop-safe' : `tier=${hw.tier}`}): whisper=${defaults.whisperModel}, ollama=${ollamaOverride ?? defaults.ollamaModel}`,
  );
});
