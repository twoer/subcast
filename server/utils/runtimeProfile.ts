/* SPDX-License-Identifier: Apache-2.0 */
import { detectHardware, type HardwareInfo } from './hardware';

export type RuntimeGpuBackend = 'metal' | 'cuda' | 'cpu' | 'unknown';
export type RuntimeProfileWarning =
  | 'cuda_unavailable'
  | 'metal_unverified'
  | 'low_memory'
  | 'gpu_unknown';

export interface RuntimeProfile {
  id: string;
  gpuBackend: RuntimeGpuBackend;
  requestedBackend: RuntimeGpuBackend;
  verifiedBackend: RuntimeGpuBackend;
  verified: boolean;
  parallelSlots: number;
  perSlotContext: number;
  gpuLayers: number;
  loadMode: 'mmap' | 'mmap+mlock';
  flashAttention: 'auto' | 'off';
  warnings: RuntimeProfileWarning[];
}

export type RuntimeHardwareInput = Pick<
  HardwareInfo,
  'platform' | 'arch' | 'totalMemoryGB' | 'gpu'
>;

const STANDARD_CONTEXT = 8192;
const ENTRY_CONTEXT = 6144;

export function resolveRuntimeProfile(
  hardware: RuntimeHardwareInput = detectHardware(),
): RuntimeProfile {
  const warnings: RuntimeProfileWarning[] = [];
  const lowMemory = hardware.totalMemoryGB < 8;
  if (lowMemory) warnings.push('low_memory');

  if (hardware.platform === 'macOS' && hardware.arch === 'arm64') {
    warnings.push('metal_unverified');
    return {
      id: lowMemory ? 'macos-metal-entry' : 'macos-metal-standard',
      gpuBackend: 'metal',
      requestedBackend: 'metal',
      verifiedBackend: 'unknown',
      verified: false,
      parallelSlots: lowMemory ? 1 : 2,
      perSlotContext: lowMemory ? ENTRY_CONTEXT : STANDARD_CONTEXT,
      gpuLayers: 999,
      loadMode: 'mmap+mlock',
      flashAttention: 'auto',
      warnings,
    };
  }

  if (hardware.platform === 'Windows') {
    // Windows CUDA is intentionally disabled until a dedicated CUDA asset,
    // DLL staging, and driver-failure UX ship together. The current
    // win32-x64 llama.cpp asset is the CPU build.
    if (hardware.gpu === 'nvidia') warnings.push('cuda_unavailable');
    return {
      id: lowMemory ? 'windows-cpu-entry' : 'windows-cpu-standard',
      gpuBackend: 'cpu',
      requestedBackend: 'cpu',
      verifiedBackend: 'cpu',
      verified: true,
      parallelSlots: lowMemory ? 1 : 2,
      perSlotContext: lowMemory ? ENTRY_CONTEXT : STANDARD_CONTEXT,
      gpuLayers: 0,
      loadMode: 'mmap',
      flashAttention: 'off',
      warnings,
    };
  }

  if (hardware.gpu === 'unknown') warnings.push('gpu_unknown');
  return {
    id: lowMemory ? 'cpu-entry' : 'cpu-standard',
    gpuBackend: 'cpu',
    requestedBackend: 'cpu',
    verifiedBackend: 'cpu',
    verified: true,
    parallelSlots: lowMemory ? 1 : 2,
    perSlotContext: lowMemory ? ENTRY_CONTEXT : STANDARD_CONTEXT,
    gpuLayers: 0,
    loadMode: 'mmap',
    flashAttention: 'off',
    warnings,
  };
}

export function activeRuntimeProfile(): RuntimeProfile {
  return resolveRuntimeProfile();
}

export function runtimeProfileDiagnostics(profile: RuntimeProfile = activeRuntimeProfile()): RuntimeProfile {
  return { ...profile, warnings: [...profile.warnings] };
}
