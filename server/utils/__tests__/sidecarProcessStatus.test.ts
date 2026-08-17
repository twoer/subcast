/* SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { detectSubcastSidecars } from '../sidecarProcessStatus';

describe('detectSubcastSidecars', () => {
  it('detects Subcast-owned sidecar processes by root without leaking details', async () => {
    const status = await detectSubcastSidecars({
      roots: ['/Users/alice/Library/Application Support/subcast'],
      exec: async () => ({
        stdout:
          '123 /opt/homebrew/bin/llama-server --model /tmp/other.gguf\n' +
          '456 /Applications/Subcast.app/Contents/Resources/llama-server --model /Users/alice/Library/Application Support/subcast/models/llm/qwen.gguf\n' +
          '789 /Applications/Subcast.app/Contents/Resources/whisper-server -m /Users/alice/Library/Application Support/subcast/models/whisper/model.bin\n',
      }),
    });

    expect(status).toEqual({ llamaServer: true, whisperServer: true });
    expect(status).not.toHaveProperty('pid');
    expect(status).not.toHaveProperty('command');
  });

  it('ignores sidecars that are not tied to Subcast roots', async () => {
    const status = await detectSubcastSidecars({
      roots: ['/Users/alice/Library/Application Support/subcast'],
      exec: async () => ({
        stdout: '123 /opt/homebrew/bin/llama-server --model /tmp/other.gguf\n',
      }),
    });

    expect(status).toEqual({ llamaServer: false, whisperServer: false });
  });
});
