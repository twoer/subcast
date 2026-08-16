/* SPDX-License-Identifier: Apache-2.0 */

/**
 * Qwen3 `<think>` block handling.
 *
 * Qwen3 emits `<think>…</think>` reasoning before the answer unless
 * thinking is disabled at request time (`chat_template_kwargs.
 * enable_thinking=false` in `llmBackendLlamaServer.ts`). When the server
 * honors that flag the content is clean and this module is a no-op; it
 * exists as the second line of defense for cases where the flag is
 * ignored (older llama-server, non-Qwen3 template fallback) — a leaked
 * think block would otherwise corrupt translate's JSON parsing and
 * insights' markdown parsing.
 *
 * Note llama-server *also* separates reasoning into a distinct
 * `reasoning_content` response field on recent builds; the backend
 * simply never reads that field. This module only guards against think
 * blocks embedded in `content` itself.
 */

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Strip think blocks from a complete (non-streaming) completion.
 * Handles the truncated case too: an unclosed `<think>` (generation
 * cut off mid-reasoning by max_tokens) swallows everything after it —
 * correct, since nothing after the marker is answer text.
 */
export function stripThinkBlocks(text: string): string {
  let out = text;
  let idx = out.indexOf(THINK_OPEN);
  while (idx !== -1) {
    const end = out.indexOf(THINK_CLOSE, idx + THINK_OPEN.length);
    if (end === -1) {
      out = out.slice(0, idx);
      break;
    }
    out = out.slice(0, idx) + out.slice(end + THINK_CLOSE.length);
    idx = out.indexOf(THINK_OPEN);
  }
  return out.trim();
}

/** Longest proper prefix of `<think>` (used for chunk-boundary holdback). */
const OPEN_MAX_PARTIAL = THINK_OPEN.length - 1;

/**
 * Length of the longest suffix of `s` that is a proper prefix of
 * `<think>` — i.e. how many trailing chars may still grow into an
 * opening marker and must not be emitted yet.
 */
function trailingPartialOpenLen(s: string): number {
  const max = Math.min(OPEN_MAX_PARTIAL, s.length);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(THINK_OPEN.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Incremental filter for streaming deltas. Feed each content delta via
 * `push()`; it returns whatever is safe to emit now (possibly empty —
 * chars are held back while a potential `<think>` marker straddles
 * chunk boundaries). Call `flush()` on stream end to release any
 * held-back tail.
 */
export class ThinkStreamFilter {
  private buf = '';
  private insideThink = false;

  push(delta: string): string {
    this.buf += delta;
    let out = '';
    while (this.buf) {
      if (this.insideThink) {
        const close = this.buf.indexOf(THINK_CLOSE);
        if (close === -1) {
          // Keep the tail that could contain a partial `</think>` marker.
          const keep = Math.min(THINK_CLOSE.length - 1, this.buf.length);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        this.buf = this.buf.slice(close + THINK_CLOSE.length);
        this.insideThink = false;
        continue;
      }
      const open = this.buf.indexOf(THINK_OPEN);
      if (open !== -1) {
        out += this.buf.slice(0, open);
        this.buf = this.buf.slice(open + THINK_OPEN.length);
        this.insideThink = true;
        continue;
      }
      const hold = trailingPartialOpenLen(this.buf);
      const emit = this.buf.length - hold;
      out += this.buf.slice(0, emit);
      this.buf = this.buf.slice(emit);
      break;
    }
    return out;
  }

  flush(): string {
    const rest = this.buf;
    this.buf = '';
    return this.insideThink ? '' : rest;
  }
}
