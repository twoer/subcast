/* SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ensureMock = vi.hoisted(() => vi.fn(async () => {}));
const noteSuccessMock = vi.hoisted(() => vi.fn());
const runProcessMock = vi.hoisted(() => vi.fn());
const paths = vi.hoisted(() => ({
  cli: '/nonexistent/whisper-cli',
  model: '/nonexistent/ggml-test.bin',
}));

vi.mock('../whisperServer', () => ({
  getWhisperServer: () => ({
    ensure: ensureMock,
    getPort: () => 51302,
    noteSuccess: noteSuccessMock,
  }),
}));

vi.mock('../whisperPaths', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../whisperPaths')>();
  return {
    ...orig,
    // Getter keeps the export live — beforeEach repoints it per test
    // (a plain property would freeze the hoisted initial value).
    get WHISPER_CLI_PATH() {
      return paths.cli;
    },
    whisperModelPath: () => paths.model,
  };
});

vi.mock('../process', () => ({ runProcess: runProcessMock }));

vi.mock('../log', () => ({ logEvent: vi.fn() }));

/* eslint-disable import/first -- mocks must be registered before imports */
import { logEvent } from '../log';
import { transcribeChunk } from '../whisper';
/* eslint-enable import/first */

const SAMPLE_RATE = 16_000;

function makeWav(seconds: number): Buffer {
  const dataLength = Math.round(seconds * SAMPLE_RATE * 2);
  const buf = Buffer.alloc(44 + dataLength);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLength, 40);
  return buf;
}

describe('transcribeChunk via whisper-server', () => {
  let dir: string;
  let wavPath: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whisper-server-path-'));
    wavPath = join(dir, 'parent.wav');
    // 62 s so the tests' [60, 60.5) / [10, 10.5) slices stay in range.
    writeFileSync(wavPath, makeWav(62));
    paths.cli = join(dir, 'whisper-cli');
    paths.model = join(dir, 'ggml-test.bin');
    writeFileSync(paths.cli, '#!/bin/sh\n');
    writeFileSync(paths.model, 'x');
    originalFetch = globalThis.fetch;
    ensureMock.mockClear().mockResolvedValue(undefined);
    noteSuccessMock.mockClear();
    runProcessMock.mockReset();
    vi.mocked(logEvent).mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('POSTs the in-memory slice and offsets returned cues to absolute time', async () => {
    let capturedBody: FormData | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:51302/inference');
      capturedBody = init?.body as FormData;
      return {
        ok: true,
        status: 200,
        async text() {
          return 'WEBVTT\n\n00:00:00.500 --> 00:00:01.000\nhello world\n';
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // 31.5 s slice: the resulting 60×-realtime timeout (~1.89 M ms) is
    // fractional — this guards the Math.round in the timeout math.
    // Shorter slices sit under the 60 s floor (integer 60 000) and never
    // exercise the fractional path (the live "delay is out of range"
    // regression slipped through exactly that gap).
    const cues = await transcribeChunk(wavPath, 3, 30, 61.5, { temperature: 0.4 });

    // Slice [30, 61.5) came back with cue at 500-1000ms → absolute 30500-31000.
    expect(cues).toEqual([{ startMs: 30_500, endMs: 31_000, text: 'hello world' }]);
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(noteSuccessMock).toHaveBeenCalledTimes(1);
    expect(capturedBody!.get('response_format')).toBe('vtt');
    expect(capturedBody!.get('temperature')).toBe('0.4');
    expect(capturedBody!.get('language')).toBe('auto');
    // No CLI spawn on the happy path.
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it('falls back to the whisper-cli spawn when the server request fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('whisper-server returned 500: boom');
    }) as unknown as typeof fetch;

    runProcessMock.mockImplementation(async (_bin: string, args: string[]) => {
      const ofIdx = args.indexOf('-of');
      writeFileSync(
        `${args[ofIdx + 1]}.vtt`,
        'WEBVTT\n\n00:00:00.000 --> 00:00:00.400\nfallback cue\n',
      );
      return { code: 0, stdout: '', stderr: '' };
    });

    const cues = await transcribeChunk(wavPath, 0, 10, 10.5);
    expect(cues).toEqual([{ startMs: 10_000, endMs: 10_400, text: 'fallback cue' }]);
    expect(runProcessMock).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'whisper_server_fallback_cli' }),
    );
  });
});
