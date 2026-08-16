/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WhisperModelName } from '#shared/whisperModels';
import { isLlmModelId } from '#shared/llmModels';
import type { LlmModelId } from '#shared/llmModels';
import { getDb } from './db';
import { logEvent } from './log';
import type { SettingsRow } from '../types/db';

export type ChunkingStrategy = 'vad' | 'fixed-time';
export const CHUNKING_STRATEGIES: readonly ChunkingStrategy[] = ['vad', 'fixed-time'];

export function isChunkingStrategy(value: unknown): value is ChunkingStrategy {
  return (
    typeof value === 'string' &&
    (CHUNKING_STRATEGIES as readonly string[]).includes(value)
  );
}
/**
 * `auto`: sample the opening segments, vote on the dominant language,
 * then dispatch — CJK → SenseVoice, English → Whisper when its model is
 * installed (SenseVoice fallback otherwise). `whisper` / `sensevoice`
 * pin the engine manually.
 */
export type TranscribeEngine = 'auto' | 'whisper' | 'sensevoice';

export const TRANSCRIBE_ENGINES: readonly TranscribeEngine[] = ['auto', 'whisper', 'sensevoice'];

export function isTranscribeEngine(value: unknown): value is TranscribeEngine {
  return (
    typeof value === 'string' &&
    (TRANSCRIBE_ENGINES as readonly string[]).includes(value)
  );
}

export interface SubcastSettings {
  whisperModel: WhisperModelName;
  /**
   * Local ASR engine. `auto` (default) picks per audio: SenseVoice for
   * CJK (bundled + seeded on first boot, segment-level cues), Whisper
   * for English when its model is installed. `whisper` / `sensevoice`
   * pin manually — all whisper tiers are on-demand downloads.
   */
  transcribeEngine: TranscribeEngine;
  llmModel: LlmModelId | undefined;
  cacheLimitGB: number;
  silenceThresholdMs: number;
  debugMode: boolean;
  /**
   * `vad` (default): pre-segment audio with Silero VAD so Whisper only
   * sees actual speech regions. Faster on long videos with silences,
   * fewer hallucinations.
   * `fixed-time`: legacy 30-second uniform slicing — kept as an opt-out
   * for environments where the VAD model fails to load.
   */
  chunkingStrategy: ChunkingStrategy;
  /**
   * Auto-polish the transcript with the local LLM once transcription
   * completes (homophone fixes, zh/en normalization, punctuation). The
   * polished layer is stored next to the original (`polished.vtt`) and
   * never replaces it. Default ON — gated at runtime on an installed
   * `llmModel`, so it stays inert until the setup wizard's step 2.
   */
  transcriptPolish: boolean;
  /**
   * Free-form domain hints (names, places, jargon) injected into the
   * polish prompt. Empirically the single biggest quality lever for
   * proper-noun correction. Empty string = no hints.
   */
  polishHints: string;
}

export const DEFAULT_SETTINGS: SubcastSettings = {
  whisperModel: 'base',
  transcribeEngine: 'auto',
  llmModel: undefined,
  cacheLimitGB: 10,
  silenceThresholdMs: 10_000,
  debugMode: false,
  chunkingStrategy: 'vad',
  transcriptPolish: true,
  polishHints: '',
};

const KEY = 'subcast.v1';

/**
 * Qwen2.5 → Qwen3 tier remap. Old settings rows carry `3b`/`7b`/`14b`
 * (Qwen2.5 sizes); the Qwen3 catalog uses `4b`/`8b`/`14b`. Applied to
 * both the stored `llmModel` and the 0.1 Ollama migration hint. Values
 * that are already valid Qwen3 ids pass through unchanged; anything
 * else is dropped (caller falls back to the tier default).
 */
const LEGACY_LLM_TIER: Record<string, LlmModelId> = {
  '3b': '4b',
  '7b': '8b',
};

/** Exported for `/api/desktop/llm/status` — hint sidecars may hold pre-Qwen3 ids. */
export function remapLegacyLlmTier(value: unknown): LlmModelId | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase();
  return LEGACY_LLM_TIER[v] ?? (isLlmModelId(v) ? (v as LlmModelId) : undefined);
}

/**
 * Pure data transform: takes a raw parsed settings blob (which may still
 * carry the 0.1 `ollamaModel` field), strips the legacy field, and
 * surfaces a tier hint (`_migrationHint`) the setup wizard can use to
 * pre-select the user's previous tier. Qwen2.5 tier ids are remapped to
 * their Qwen3 equivalents. Pure — no I/O. The caller (`loadSettings`)
 * is responsible for persisting the hint to a sidecar file before
 * discarding it.
 */
export function migrateLegacySettings(
  parsed: Record<string, unknown>,
): Partial<SubcastSettings> & { _migrationHint?: LlmModelId } {
  const { ollamaModel, llmModel, ...rest } = parsed;
  const migrated = { ...rest } as Partial<SubcastSettings>;
  if (typeof llmModel === 'string') {
    const remapped = remapLegacyLlmTier(llmModel);
    if (remapped) migrated.llmModel = remapped;
  }
  if (typeof ollamaModel === 'string') {
    const m = /^(qwen2\.5|qwen3):(\d+b)$/i.exec(ollamaModel);
    const hint = m ? remapLegacyLlmTier(m[2]) : undefined;
    return { ...migrated, _migrationHint: hint };
  }
  return migrated;
}

/**
 * Write a one-shot hint the setup wizard reads on first run to
 * pre-select the user's previous Qwen2.5 tier. Idempotent: skip if the
 * file already exists. Best-effort: any I/O error is swallowed (worst
 * case, the wizard simply defaults to the hardware-recommended tier).
 * Desktop-only — there is no `<userData>/models/llm` in web mode.
 */
function writeMigrationHint(hint: LlmModelId): void {
  if (process.env.SUBCAST_DESKTOP !== 'true') return;
  const home = process.env.SUBCAST_HOME;
  if (!home) return;
  try {
    const dir = join(home, 'models', 'llm');
    const file = join(dir, '.migration-hint.json');
    if (existsSync(file)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ id: hint }), 'utf8');
  } catch (err) {
    logEvent({
      level: 'debug',
      event: 'migration_hint_write_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function loadSettings(): SubcastSettings {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(KEY) as Pick<SettingsRow, 'value'> | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const migrated = migrateLegacySettings(parsed);
    if (migrated._migrationHint) writeMigrationHint(migrated._migrationHint);
    const { _migrationHint: _drop, ...clean } = migrated;
    void _drop;
    return { ...DEFAULT_SETTINGS, ...clean };
  } catch (err) {
    logEvent({
      level: 'debug',
      event: 'settings_parse_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(next: Partial<SubcastSettings>): SubcastSettings {
  const db = getDb();
  const merged: SubcastSettings = { ...loadSettings(), ...next };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(KEY, JSON.stringify(merged));
  return merged;
}

export function isFirstBoot(): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 AS x FROM settings WHERE key = ?`)
    .get(KEY) as { x: number } | undefined;
  return !row;
}
