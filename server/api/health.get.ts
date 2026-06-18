/* SPDX-License-Identifier: Apache-2.0 */
import { detectHardware } from '../utils/hardware';
import { detectHealth } from '../utils/health';
import { loadSettings } from '../utils/settings';

const INSTALL_HINTS = {
  macOS: {
    'whisper-cli':
      'cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
  Linux: {
    'whisper-cli':
      'cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
  Windows: {
    'whisper-cli':
      'cd node_modules\\nodejs-whisper\\cpp\\whisper.cpp\\build && cmake --build . --target whisper-cli --config Release',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
  unknown: {
    'whisper-cli':
      'cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
} as const;

export default defineEventHandler(async () => {
  const settings = loadSettings();
  const hardware = detectHardware();
  const health = await detectHealth({ whisperModel: settings.whisperModel });
  const hints = INSTALL_HINTS[hardware.platform];
  const fixes: Array<{ id: string; description: string; command: string }> = [];
  for (const m of health.missing) {
    if (m === 'whisper-cli') {
      fixes.push({
        id: m,
        description: 'Build whisper-cli binary',
        command: hints['whisper-cli'],
      });
    } else if (m.startsWith('whisper-model:')) {
      const model = m.slice('whisper-model:'.length);
      fixes.push({
        id: m,
        description: `Download whisper model ${model}`,
        command: hints['whisper-model'](model),
      });
    }
  }
  // Suppress the LAN URL in desktop mode — the Electron shell loads
  // 127.0.0.1, so the LAN address is meaningless there and just clutters
  // the header. Web/dev mode still surfaces it for LAN-demo flows.
  const isDesktop = process.env.SUBCAST_DESKTOP === 'true';
  return {
    settings,
    hardware,
    health,
    fixes,
    lanUrl: !isDesktop && hardware.lanIp ? `http://${hardware.lanIp}:3000` : null,
  };
});
