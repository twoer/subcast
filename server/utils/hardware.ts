/* SPDX-License-Identifier: Apache-2.0 */
import { totalmem, cpus, platform, arch, networkInterfaces } from 'node:os';
import type { WhisperModelName } from '#shared/whisperModels';
import type { LlmModelId } from '#shared/llmModels';

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
    whisperModel: WhisperModelName;
    llmModel: LlmModelId;
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
  // LLM tier mapping intentionally caps `standard` (8 GB) at the 3B
  // model: a 4-bit-quantized 7B GGUF + working set comfortably exceeds
  // the headroom an 8 GB Mac has after macOS + Chromium + Subcast itself.
  switch (tier) {
    case 'entry':
      return { whisperModel: 'base', llmModel: '3b' };
    case 'standard':
      return { whisperModel: 'small', llmModel: '3b' };
    case 'recommended':
      return { whisperModel: 'medium', llmModel: '7b' };
    case 'high':
      return { whisperModel: 'large-v3-turbo', llmModel: '14b' };
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
