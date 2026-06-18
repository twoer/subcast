/* SPDX-License-Identifier: Apache-2.0 */
import { ref, type Ref } from 'vue';

/**
 * Shared upload-status state for the home page.
 *
 * `useHomeUpload`, `useBatchStaging`, and `useDesktopOpenFileUpload` all drive
 * the same upload button / error banner on the home page, so they share one
 * status instance rather than each owning private refs. Passing this object
 * around (instead of three loose refs) makes the sharing explicit and gives
 * every entry point a single place to enforce "don't start a new upload while
 * one is already running" via `status.isUploading.value`.
 */
export interface UploadStatus {
  isUploading: Ref<boolean>;
  error: Ref<string | null>;
  info: Ref<string | null>;
  /** Clear any surfaced error/info message. Leaves `isUploading` untouched. */
  reset: () => void;
}

export function useUploadStatus(): UploadStatus {
  const isUploading = ref(false);
  const error = ref<string | null>(null);
  const info = ref<string | null>(null);

  function reset(): void {
    error.value = null;
    info.value = null;
  }

  return { isUploading, error, info, reset };
}
