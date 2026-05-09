// First-boot bootstrap: write hardware-recommended defaults into the settings
// table the first time the app runs. Honors SUBCAST_OLLAMA_MODEL env override
// for backwards compatibility with Slice 5 dev workflows.
import { detectHardware } from '../utils/hardware';
import { isFirstBoot, saveSettings } from '../utils/settings';

export default defineNitroPlugin(() => {
  if (!isFirstBoot()) return;
  const hw = detectHardware();
  const ollamaOverride = process.env.SUBCAST_OLLAMA_MODEL;
  saveSettings({
    whisperModel: hw.recommended.whisperModel,
    ollamaModel: ollamaOverride && ollamaOverride.length > 0
      ? ollamaOverride
      : hw.recommended.ollamaModel,
  });
  // eslint-disable-next-line no-console
  console.log(
    `[subcast] first-boot defaults: tier=${hw.tier}, whisper=${hw.recommended.whisperModel}, ollama=${ollamaOverride ?? hw.recommended.ollamaModel}`,
  );
});
