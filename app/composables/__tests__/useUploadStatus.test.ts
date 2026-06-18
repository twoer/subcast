/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { useUploadStatus } from '../useUploadStatus';

describe('useUploadStatus', () => {
  it('starts idle with no error or info', () => {
    const status = useUploadStatus();
    expect(status.isUploading.value).toBe(false);
    expect(status.error.value).toBeNull();
    expect(status.info.value).toBeNull();
  });

  it('reset clears error and info but leaves isUploading untouched', () => {
    const status = useUploadStatus();
    status.error.value = 'something failed';
    status.info.value = 'something happened';
    status.isUploading.value = true;

    status.reset();

    expect(status.error.value).toBeNull();
    expect(status.info.value).toBeNull();
    // reset must not flip isUploading — callers manage the busy flag via
    // its own try/finally so a reset mid-flight can't silently "finish" an
    // upload that is still running.
    expect(status.isUploading.value).toBe(true);
  });

  it('reset is safe to call when nothing is set', () => {
    const status = useUploadStatus();
    expect(() => status.reset()).not.toThrow();
    expect(status.error.value).toBeNull();
    expect(status.info.value).toBeNull();
  });
});
