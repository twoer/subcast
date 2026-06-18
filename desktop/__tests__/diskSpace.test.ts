/* SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_SAFETY_MULTIPLIER,
  VIDEO_FREE_FLOOR_BYTES,
  checkSpaceForModel,
  checkSpaceForVideo,
  humanSize,
} from '../diskSpace';

function fakeCheck(free: number) {
  return vi.fn().mockResolvedValue({ free, size: free * 2, diskPath: '/' });
}

describe('checkSpaceForModel', () => {
  it('passes when free space comfortably exceeds required (1.5× model size)', async () => {
    const model = 100_000_000;
    const required = Math.ceil(model * MODEL_SAFETY_MULTIPLIER);
    const result = await checkSpaceForModel(model, '/tmp', {
      checkDiskSpace: fakeCheck(required + 1),
    });

    expect(result.ok).toBe(true);
    expect(result.requiredBytes).toBe(required);
  });

  it('fails with helpful diagnostics when free < required', async () => {
    const model = 100_000_000;
    const free = 50_000_000;
    const result = await checkSpaceForModel(model, '/tmp', {
      checkDiskSpace: fakeCheck(free),
    });

    expect(result.ok).toBe(false);
    expect(result.freeBytes).toBe(free);
    expect(result.requiredBytes).toBe(150_000_000);
    expect(result.message).toContain('150');
  });
});

describe('checkSpaceForVideo', () => {
  it('passes above the absolute free-space floor', async () => {
    const result = await checkSpaceForVideo(300, '/tmp', {
      checkDiskSpace: fakeCheck(VIDEO_FREE_FLOOR_BYTES * 2),
    });
    expect(result.ok).toBe(true);
  });

  it('warns (not blocks) when below the floor', async () => {
    const result = await checkSpaceForVideo(300, '/tmp', {
      checkDiskSpace: fakeCheck(VIDEO_FREE_FLOOR_BYTES - 1),
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toBe(true);
  });
});

describe('humanSize', () => {
  it.each([
    [500, '500 B'],
    [1500, '2 KB'],
    [1_500_000, '2 MB'],
    [1_500_000_000, '1.50 GB'],
  ])('formats %i as %s', (n, expected) => {
    expect(humanSize(n)).toBe(expected);
  });
});
