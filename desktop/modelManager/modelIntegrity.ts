/* SPDX-License-Identifier: Apache-2.0 */

import { open, stat } from 'node:fs/promises';

const GGML_MAGICS_LE: ReadonlySet<number> = new Set([0x67676d6c, 0x67676d66, 0x67676a74]);
const GGUF_MAGIC = 'GGUF';

export class ModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelIntegrityError';
  }
}

async function readFirstBytes(path: string, length: number): Promise<Buffer | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return bytesRead === length ? buf : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

export async function assertWhisperModelIntegrity(
  path: string,
  expected: {
    minBytes: number;
    maxBytes?: number;
    label: string;
  },
): Promise<void> {
  const st = await stat(path);
  if (!st.isFile()) {
    throw new ModelIntegrityError(`${expected.label} is not a file: ${path}`);
  }
  if (st.size < expected.minBytes) {
    throw new ModelIntegrityError(
      `${expected.label} is too small (${st.size} bytes, expected at least ${expected.minBytes})`,
    );
  }
  if (expected.maxBytes !== undefined && st.size > expected.maxBytes) {
    throw new ModelIntegrityError(
      `${expected.label} is too large (${st.size} bytes, expected at most ${expected.maxBytes})`,
    );
  }

  const header = await readFirstBytes(path, 4);
  if (header === null || !GGML_MAGICS_LE.has(header.readUInt32LE(0))) {
    throw new ModelIntegrityError(`${expected.label} does not look like a GGML model`);
  }
}

export async function assertGgufModelIntegrity(
  path: string,
  expected: {
    sizeBytes: number;
    label: string;
  },
): Promise<void> {
  const st = await stat(path);
  if (!st.isFile()) {
    throw new ModelIntegrityError(`${expected.label} is not a file: ${path}`);
  }

  const minBytes = expected.sizeBytes * 0.7;
  const maxBytes = expected.sizeBytes * 1.3;
  if (st.size < minBytes || st.size > maxBytes) {
    throw new ModelIntegrityError(
      `${expected.label} size ${st.size} bytes outside expected range ${Math.floor(minBytes)}-${Math.ceil(maxBytes)}`,
    );
  }

  const header = await readFirstBytes(path, 4);
  if (header === null || header.toString('ascii') !== GGUF_MAGIC) {
    throw new ModelIntegrityError(`${expected.label} does not look like a GGUF model`);
  }
}
