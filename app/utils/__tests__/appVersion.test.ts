/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { resolveAppVersion } from '../appVersion';

describe('resolveAppVersion', () => {
  it('prefers the packaged Electron version', () => {
    expect(resolveAppVersion('0.6.0', '0.5.0')).toBe('0.6.0');
  });

  it('uses the build-time package version in web mode', () => {
    expect(resolveAppVersion(null, '0.5.0')).toBe('0.5.0');
  });

  it('returns an explicit fallback when neither source is available', () => {
    expect(resolveAppVersion(null, undefined)).toBe('unknown');
  });
});
