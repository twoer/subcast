/* SPDX-License-Identifier: Apache-2.0 */
import type { SpeakerId } from '#shared/diarization';

export interface PlayerDiarizeActionSource {
  run: () => Promise<void>;
  reconsolidate: (topK: number) => Promise<void>;
  rename: (speakerId: SpeakerId, displayName: string | null) => Promise<void>;
}

export interface PlayerDiarizeActionOptions {
  onError?: (message: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function usePlayerDiarizeActions(
  diarize: PlayerDiarizeActionSource,
  options?: PlayerDiarizeActionOptions,
) {
  async function renameSpeaker(speakerId: SpeakerId, displayName: string | null): Promise<void> {
    try {
      await diarize.rename(speakerId, displayName);
    } catch (err) {
      options?.onError?.(errorMessage(err));
    }
  }

  async function changeTopK(topK: number): Promise<void> {
    try {
      await diarize.reconsolidate(topK);
    } catch (err) {
      options?.onError?.(errorMessage(err));
    }
  }

  async function run(): Promise<void> {
    try {
      await diarize.run();
    } catch (err) {
      options?.onError?.(errorMessage(err));
    }
  }

  return { renameSpeaker, changeTopK, run };
}
