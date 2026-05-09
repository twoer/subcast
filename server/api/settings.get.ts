import { detectHardware } from '../utils/hardware';
import { loadSettings } from '../utils/settings';

export default defineEventHandler(() => {
  return {
    settings: loadSettings(),
    hardware: detectHardware(),
  };
});
