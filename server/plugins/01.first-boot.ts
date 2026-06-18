/* SPDX-License-Identifier: Apache-2.0 */
// First-boot bootstrap: write defaults into the settings table the first
// time the app runs.
//
//   * Web mode  — keep the original hardware-tier whisper recommendation;
//                 web devs have whatever models they manually pulled, and
//                 the home health banner surfaces mismatches.
//   * Desktop   — boot with a conservative whisper default (base) so the
//                 setup wizard's first-run check doesn't end up pointing
//                 at a model the user hasn't installed yet. The wizard
//                 then writes the user's actual choice
//                 (`persistWhisperChoice` on Step 1 "Next") and overrides
//                 the default.
//
// `llmModel` is intentionally left undefined here — the setup wizard
// step 2 picks the tier explicitly and saves it; until then the LLM
// backend stays dormant. The legacy SUBCAST_OLLAMA_MODEL env override is
// retired with the 0.2 settings shape (it referred to an Ollama tag, not
// a tier id).
import { detectHardware } from '../utils/hardware';
import { isFirstBoot, saveSettings } from '../utils/settings';

const DESKTOP_SAFE_DEFAULTS = {
  whisperModel: 'base' as const,
};

export default defineNitroPlugin(() => {
  if (!isFirstBoot()) return;
  const desktop = process.env.SUBCAST_DESKTOP === 'true';
  const hw = detectHardware();

  const defaults = desktop
    ? DESKTOP_SAFE_DEFAULTS
    : { whisperModel: hw.recommended.whisperModel };

  saveSettings({
    whisperModel: defaults.whisperModel,
    llmModel: undefined,
  });

  console.log(
    `[subcast] first-boot defaults (${desktop ? 'desktop-safe' : `tier=${hw.tier}`}): whisper=${defaults.whisperModel}, llm=<unset>`,
  );
});
