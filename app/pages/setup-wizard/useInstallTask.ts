/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Generic install task state machine for the setup wizard.
 *
 * Step 1 (Whisper) and Step 2 (LLM) used to ship two near-identical
 * copies — same polling loop, same start / cancel, same set of
 * state-transition computeds, only the endpoint and snapshot type
 * differing. Consolidating them here keeps the two halves in
 * lock-step (a fix to one's poll loop or error message is now
 * automatically the other's).
 *
 * Page-private on purpose: setup-wizard is the only caller. Living in
 * `app/composables/` would make it look like a reusable building block;
 * it isn't.
 */

import type { Ref } from 'vue';
import type { InstallTaskSnapshotBase } from '#shared/installContracts';

const POLL_INTERVAL_MS = 500;
const MAX_POLL_FAILURES = 5;

// `InstallTaskSnapshotBase` itself has no `model` field — Whisper and LLM
// each add their own (typed to their respective id unions). The composable
// only needs `model: string` for the `ownsSelection` equality check, so we
// widen the constraint here rather than touching the shared contract.
type SnapshotWithModel = InstallTaskSnapshotBase & { model: string };

export interface UseInstallTaskOptions<TSnapshot extends SnapshotWithModel> {
  /** REST endpoint serving GET (current task) / POST (start) / DELETE (cancel). */
  endpoint: string;
  /** Currently-selected model id in the wizard step. Gates the
   *  `ownsSelection` computed so a stale snapshot from a previous tier
   *  doesn't leak into the new selection's UI. */
  selected: Ref<TSnapshot['model']>;
  /** Fired after the task transitions to `success` — either via the
   *  synchronous response of `startInstall`, or via a polling tick.
   *  Typical use: re-fetch the page's status fixture so newly-installed
   *  models surface in the list. */
  onSuccess?: () => void | Promise<void>;
}

export function useInstallTask<TSnapshot extends SnapshotWithModel>(
  opts: UseInstallTaskOptions<TSnapshot>,
) {
  const { t } = useI18n();

  const task = ref<TSnapshot | null>(null);
  const actionError = ref<string | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollFailures = 0;

  async function pollOnce(): Promise<void> {
    try {
      // h3 serializes a `null` return as an empty body when no
      // Content-Type is set, so `$fetch` can resolve to `undefined`.
      // Normalize to `null` so downstream `task.value !== null` guards
      // stay reliable — `undefined !== null` was passing the guard and
      // crashing later reads of `task.value.model`.
      const next = await $fetch<TSnapshot | null>(opts.endpoint);
      task.value = (next ?? null) as TSnapshot | null;
      pollFailures = 0;
    } catch {
      pollFailures++;
      if (pollFailures >= MAX_POLL_FAILURES) {
        stopPolling();
        actionError.value = t('desktop.setupWizard.pollFailed');
      }
    }
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    pollFailures = 0;
    pollTimer = setInterval(() => {
      void pollOnce().then(() => {
        if (task.value && task.value.state !== 'running') {
          stopPolling();
          if (task.value.state === 'success' && opts.onSuccess) {
            void opts.onSuccess();
          }
        }
      });
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  const ownsSelection = computed<boolean>(
    () => task.value?.model === opts.selected.value,
  );
  const running = computed<boolean>(
    () => ownsSelection.value && task.value?.state === 'running',
  );
  const succeeded = computed<boolean>(
    () => ownsSelection.value && task.value?.state === 'success',
  );
  const failed = computed<boolean>(
    () => ownsSelection.value && task.value?.state === 'error',
  );
  const canceled = computed<boolean>(
    () => ownsSelection.value && task.value?.state === 'canceled',
  );

  const progressPercent = computed<number>(() => {
    const p = task.value?.progress;
    if (!p || !p.bytesTotal) return 0;
    return Math.min(100, Math.floor((p.bytesDownloaded / p.bytesTotal) * 100));
  });

  async function startInstall(body: Record<string, unknown>): Promise<void> {
    actionError.value = null;
    try {
      task.value = await $fetch<TSnapshot>(opts.endpoint, {
        method: 'POST',
        body,
      });
      if (task.value.state === 'running') startPolling();
      if (task.value.state === 'success' && opts.onSuccess) {
        void opts.onSuccess();
      }
    } catch (e) {
      const err = e as { statusMessage?: string; message?: string };
      actionError.value =
        err.statusMessage ?? err.message ?? t('desktop.setupWizard.installStartFailed');
    }
  }

  async function cancelInstall(): Promise<void> {
    try {
      await $fetch(opts.endpoint, { method: 'DELETE' });
    } catch {
      /* surface via next poll */
    }
  }

  onBeforeUnmount(() => {
    stopPolling();
  });

  return {
    task,
    actionError,
    ownsSelection,
    running,
    succeeded,
    failed,
    canceled,
    progressPercent,
    pollOnce,
    startPolling,
    stopPolling,
    startInstall,
    cancelInstall,
  };
}
