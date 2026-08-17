/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  resolveRuntimeProfile,
  runtimeProfileDiagnostics,
  type RuntimeHardwareInput,
} from '../runtimeProfile';

const baseHardware: RuntimeHardwareInput = {
  platform: 'macOS',
  arch: 'arm64',
  totalMemoryGB: 16,
  gpu: 'apple-silicon',
};

describe('runtime profiles', () => {
  it('uses a Metal-capable profile on Apple Silicon', () => {
    const profile = resolveRuntimeProfile(baseHardware);

    expect(profile).toMatchObject({
      id: 'macos-metal-standard',
      gpuBackend: 'metal',
      requestedBackend: 'metal',
      verified: false,
      verifiedBackend: 'unknown',
      parallelSlots: 2,
      perSlotContext: 8192,
      gpuLayers: 999,
      loadMode: 'mmap+mlock',
      flashAttention: 'auto',
    });
    expect(profile.warnings).toContain('metal_unverified');
  });

  it('low-memory entry machines lower concurrency and context', () => {
    const profile = resolveRuntimeProfile({
      ...baseHardware,
      totalMemoryGB: 6,
    });

    expect(profile.id).toBe('macos-metal-entry');
    expect(profile.parallelSlots).toBe(1);
    expect(profile.perSlotContext).toBeLessThan(8192);
    expect(profile.warnings).toContain('low_memory');
  });

  it('Windows remains CPU by default and does not enable CUDA implicitly', () => {
    const profile = resolveRuntimeProfile({
      platform: 'Windows',
      arch: 'x64',
      totalMemoryGB: 32,
      gpu: 'nvidia',
    });

    expect(profile.requestedBackend).toBe('cpu');
    expect(profile.gpuBackend).toBe('cpu');
    expect(profile.verifiedBackend).toBe('cpu');
    expect(profile.verified).toBe(true);
    expect(profile.gpuLayers).toBe(0);
    expect(profile.warnings).toContain('cuda_unavailable');
  });

  it('diagnostics contain runtime-only information and no paths', () => {
    const diag = JSON.stringify(runtimeProfileDiagnostics(resolveRuntimeProfile(baseHardware)));

    expect(diag).toContain('macos-metal-standard');
    expect(diag).not.toContain('/Users/');
    expect(diag).not.toContain('Documents/Code');
  });
});
