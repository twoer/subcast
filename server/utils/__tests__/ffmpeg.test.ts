import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { streamSha256 } from '../ffmpeg';

describe('streamSha256', () => {
  it('computes hex sha256 of "hello world"', async () => {
    const stream = Readable.from(Buffer.from('hello world'));
    const hash = await streamSha256(stream);
    expect(hash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    );
  });

  it('returns sha256 of empty data for empty stream', async () => {
    const stream = Readable.from(Buffer.from(''));
    const hash = await streamSha256(stream);
    expect(hash).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });
});
