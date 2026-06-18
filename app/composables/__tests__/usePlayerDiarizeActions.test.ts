/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import {
  usePlayerDiarizeActions,
  type PlayerDiarizeActionSource,
} from '../usePlayerDiarizeActions';

function makeSource(overrides: Partial<PlayerDiarizeActionSource> = {}): PlayerDiarizeActionSource {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    reconsolidate: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('usePlayerDiarizeActions', () => {
  it('runs diarization through the source action', async () => {
    const source = makeSource();
    const actions = usePlayerDiarizeActions(source);

    await actions.run();

    expect(source.run).toHaveBeenCalledTimes(1);
  });

  it('changes topK through reconsolidate', async () => {
    const source = makeSource();
    const actions = usePlayerDiarizeActions(source);

    await actions.changeTopK(4);

    expect(source.reconsolidate).toHaveBeenCalledWith(4);
  });

  it('renames a speaker and preserves null display names', async () => {
    const source = makeSource();
    const actions = usePlayerDiarizeActions(source);

    await actions.renameSpeaker('speaker_1', null);

    expect(source.rename).toHaveBeenCalledWith('speaker_1', null);
  });

  it('reports run errors', async () => {
    const source = makeSource({ run: vi.fn().mockRejectedValue(new Error('run failed')) });
    const onError = vi.fn();
    const actions = usePlayerDiarizeActions(source, { onError });

    await actions.run();

    expect(onError).toHaveBeenCalledWith('run failed');
  });

  it('reports non-error rejections as strings', async () => {
    const source = makeSource({ reconsolidate: vi.fn().mockRejectedValue('bad topK') });
    const onError = vi.fn();
    const actions = usePlayerDiarizeActions(source, { onError });

    await actions.changeTopK(9);

    expect(onError).toHaveBeenCalledWith('bad topK');
  });
});
