import { detectHardware } from '../utils/hardware';
import { detectHealth } from '../utils/health';
import { loadSettings } from '../utils/settings';

const INSTALL_HINTS = {
  macOS: {
    ollama: 'brew install ollama && ollama serve',
    'ollama-pull': (m: string) => `ollama pull ${m}`,
    'whisper-cli':
      'cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
  Linux: {
    ollama: 'curl -fsSL https://ollama.com/install.sh | sh && ollama serve',
    'ollama-pull': (m: string) => `ollama pull ${m}`,
    'whisper-cli':
      'cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
  Windows: {
    ollama:
      'Download from https://ollama.com/download then run `ollama serve` in a new terminal',
    'ollama-pull': (m: string) => `ollama pull ${m}`,
    'whisper-cli':
      'cd node_modules\\nodejs-whisper\\cpp\\whisper.cpp\\build && cmake --build . --target whisper-cli --config Release',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
  unknown: {
    ollama: 'See https://ollama.com/download',
    'ollama-pull': (m: string) => `ollama pull ${m}`,
    'whisper-cli':
      'cd node_modules/nodejs-whisper/cpp/whisper.cpp/build && cmake --build . --target whisper-cli',
    'whisper-model': (m: string) => `npx --no-install nodejs-whisper download ${m}`,
  },
} as const;

export default defineEventHandler(async () => {
  const settings = loadSettings();
  const [hardware, health] = await Promise.all([
    Promise.resolve(detectHardware()),
    detectHealth({
      whisperModel: settings.whisperModel,
      ollamaModel: settings.ollamaModel,
    }),
  ]);
  const hints = INSTALL_HINTS[hardware.platform];
  const fixes: Array<{ id: string; description: string; command: string }> = [];
  for (const m of health.missing) {
    if (m === 'ollama') {
      fixes.push({ id: m, description: 'Install & start Ollama', command: hints.ollama });
    } else if (m.startsWith('ollama-model:')) {
      const model = m.slice('ollama-model:'.length);
      fixes.push({
        id: m,
        description: `Pull Ollama model ${model}`,
        command: hints['ollama-pull'](model),
      });
    } else if (m === 'whisper-cli') {
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
  return {
    settings,
    hardware,
    health,
    fixes,
    lanUrl: hardware.lanIp ? `http://${hardware.lanIp}:3000` : null,
  };
});
