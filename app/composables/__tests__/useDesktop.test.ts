/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { hydrateDesktopStateFromBridge, type DesktopReactiveState } from '../useDesktop';

describe('hydrateDesktopStateFromBridge', () => {
  it('hydrates desktop state and returns the preload open-file registrar', () => {
    const state: DesktopReactiveState = {
      isDesktop: true,
      platform: null,
      appVersion: null,
      apiPort: null,
    };
    const onOpenFile = vi.fn();

    const registrar = hydrateDesktopStateFromBridge(state, {
      isDesktop: true,
      platform: 'darwin',
      appVersion: '0.3.5',
      apiPort: 51301,
      onOpenFile,
    });

    expect(state).toEqual({
      isDesktop: true,
      platform: 'darwin',
      appVersion: '0.3.5',
      apiPort: 51301,
    });
    expect(registrar).toBe(onOpenFile);
  });

  it('hydrates from web-mode state when the desktop bridge exists', () => {
    const state: DesktopReactiveState = {
      isDesktop: false,
      platform: null,
      appVersion: null,
      apiPort: null,
    };

    hydrateDesktopStateFromBridge(state, {
      isDesktop: true,
      platform: 'win32',
      appVersion: '0.3.5',
      apiPort: 51302,
    });

    expect(state.isDesktop).toBe(true);
    expect(state.platform).toBe('win32');
    expect(state.appVersion).toBe('0.3.5');
    expect(state.apiPort).toBe(51302);
  });

  it('returns null and leaves state unchanged when the bridge is missing', () => {
    const state: DesktopReactiveState = {
      isDesktop: false,
      platform: null,
      appVersion: null,
      apiPort: null,
    };

    expect(hydrateDesktopStateFromBridge(state, undefined)).toBeNull();
    expect(state).toEqual({
      isDesktop: false,
      platform: null,
      appVersion: null,
      apiPort: null,
    });
  });
});
