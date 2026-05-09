import { totalmem, cpus, platform, arch, networkInterfaces } from 'node:os';

export type HardwareTier = 'entry' | 'standard' | 'recommended' | 'high';

export interface HardwareInfo {
  totalMemoryGB: number;
  cpuCount: number;
  cpuModel: string;
  platform: 'macOS' | 'Linux' | 'Windows' | 'unknown';
  arch: string;
  gpu: 'apple-silicon' | 'nvidia' | 'integrated' | 'none' | 'unknown';
  tier: HardwareTier;
  recommended: {
    whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo';
    ollamaModel: string;
  };
  lanIp?: string;
}

function platformName(): HardwareInfo['platform'] {
  switch (platform()) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return 'unknown';
  }
}

function detectGpu(): HardwareInfo['gpu'] {
  if (platform() === 'darwin' && arch() === 'arm64') return 'apple-silicon';
  // Without spawning lspci/nvidia-smi we can't reliably tell. Slice 8 keeps
  // this simple; Slice 9 may upgrade with a real probe.
  return 'unknown';
}

function classifyTier(memGB: number, gpu: HardwareInfo['gpu']): HardwareTier {
  if (memGB >= 32 && gpu === 'apple-silicon') return 'high';
  if (memGB >= 16 && (gpu === 'apple-silicon' || gpu === 'nvidia')) return 'recommended';
  if (memGB >= 8) return 'standard';
  return 'entry';
}

function recommendModels(tier: HardwareTier): HardwareInfo['recommended'] {
  switch (tier) {
    case 'entry':
      return { whisperModel: 'base', ollamaModel: 'qwen2.5:1.5b' };
    case 'standard':
      return { whisperModel: 'small', ollamaModel: 'qwen2.5:7b' };
    case 'recommended':
      return { whisperModel: 'medium', ollamaModel: 'qwen2.5:7b' };
    case 'high':
      return { whisperModel: 'large-v3-turbo', ollamaModel: 'qwen2.5:14b' };
  }
}

function detectLanIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return undefined;
}

export function detectHardware(): HardwareInfo {
  const totalMemoryGB = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const cpuList = cpus();
  const cpuCount = cpuList.length;
  const cpuModel = cpuList[0]?.model ?? 'unknown';
  const plat = platformName();
  const a = arch();
  const gpu = detectGpu();
  const tier = classifyTier(totalMemoryGB, gpu);
  const recommended = recommendModels(tier);
  return {
    totalMemoryGB,
    cpuCount,
    cpuModel,
    platform: plat,
    arch: a,
    gpu,
    tier,
    recommended,
    lanIp: detectLanIp(),
  };
}
