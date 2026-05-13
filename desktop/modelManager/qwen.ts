/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Qwen model catalog + Ollama-driven pull (§ 5.4, decision 35).
 *
 * Ollama owns the actual download — we drive it via `/api/pull` with
 * `stream: true` and parse the NDJSON progress feed. Each line carries
 * `{ status, digest?, total?, completed? }`. Ollama pulls multiple layers
 * sequentially; we surface the active layer's progress as a single
 * percentage so the wizard UI stays simple.
 *
 * Why not download directly: Ollama de-duplicates layers across models,
 * stores them in its own blobs directory, and reuses them when the user
 * later installs another model that shares layers. Bypassing that hurts
 * everyone.
 */

export type QwenVariant = '3b' | '7b' | '14b';

export interface QwenModelInfo {
  /** Canonical Ollama tag (`name:tag` pair). */
  tag: string;
  /** Approximate on-disk size after pull, for UI labels. */
  sizeBytes: number;
}

export const QWEN_MODELS: Record<QwenVariant, QwenModelInfo> = {
  '3b': { tag: 'qwen2.5:3b', sizeBytes: 1_900_000_000 },
  '7b': { tag: 'qwen2.5:7b', sizeBytes: 4_700_000_000 },
  '14b': { tag: 'qwen2.5:14b', sizeBytes: 9_000_000_000 },
};

export const RECOMMENDED_QWEN: QwenVariant = '7b';

const OLLAMA_URL = process.env.SUBCAST_OLLAMA_URL ?? 'http://localhost:11434';

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

/** All installed Ollama models, regardless of family. */
export async function listInstalledOllamaModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const body = (await res.json()) as OllamaTagsResponse;
  return (body.models ?? []).map((m) => m.name);
}

/**
 * Which of our three catalog tiers does the user already have on disk.
 * Larger first — when both 7b and 14b are installed we prefer 14b in the
 * UI default since the user clearly opted into the bigger one already.
 */
export async function detectInstalledQwen(): Promise<QwenVariant[]> {
  const installed = new Set(await listInstalledOllamaModels());
  const ordered: QwenVariant[] = ['14b', '7b', '3b'];
  return ordered.filter((v) => installed.has(QWEN_MODELS[v].tag));
}

export interface QwenPullProgress {
  /** Free-text status from Ollama, e.g. "pulling manifest", "verifying sha256 digest". */
  status: string;
  /** Sha256 digest of the layer currently being pulled, if any. */
  digest?: string;
  /** Bytes pulled for the active layer. */
  completed?: number;
  /** Total bytes of the active layer. */
  total?: number;
}

export interface PullOptions {
  variant: QwenVariant;
  onProgress?: (p: QwenPullProgress) => void;
  signal?: AbortSignal;
}

interface PullLine {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * POST /api/pull (stream=true) and parse NDJSON lines. Resolves when
 * Ollama reports the `success` status, rejects on any `error` line or
 * network failure. AbortSignal aborts the underlying HTTP request.
 */
export async function pullQwenModel(options: PullOptions): Promise<void> {
  const { variant, onProgress, signal } = options;
  const tag = QWEN_MODELS[variant].tag;

  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tag, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama /api/pull returned ${res.status}`);
  if (!res.body) throw new Error('Ollama /api/pull returned an empty body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let success = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    // Flush any complete lines from the buffer.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: PullLine;
      try {
        parsed = JSON.parse(line) as PullLine;
      } catch {
        // Skip malformed line — log noise from Ollama is rare but possible.
        continue;
      }
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.status === 'success') success = true;
      onProgress?.({
        status: parsed.status,
        digest: parsed.digest,
        completed: parsed.completed,
        total: parsed.total,
      });
    }

    if (done) break;
  }

  if (!success) {
    // Ollama closed the stream without emitting a success line — could be
    // a clean abort or an undocumented edge case. Surface a generic error.
    throw new Error('Ollama closed the stream without reporting success');
  }
}
