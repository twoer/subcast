/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WhisperModelName } from '#shared/whisperModels';
import type { LlmModelId } from '#shared/llmModels';
import { getDb } from './db';
import { logEvent } from './log';
import type { SettingsRow } from '../types/db';

export type ChunkingStrategy = 'vad' | 'fixed-time';

export interface SubcastSettings {
  whisperModel: WhisperModelName;
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
}

export const DEFAULT_SETTINGS: SubcastSettings = {
  whisperModel: 'base',
  llmModel: undefined,
  cacheLimitGB: 10,
  silenceThresholdMs: 10_000,
  debugMode: false,
  chunkingStrategy: 'vad',
};

const KEY = 'subcast.v1';

/**
 * Pure data transform: takes a raw parsed settings blob (which may still
 * carry the 0.1 `ollamaModel` field), strips the legacy field, and
 * surfaces a tier hint (`_migrationHint`) the setup wizard can use to
 * pre-select the user's previous Qwen2.5 tier. Pure — no I/O. The
 * caller (`loadSettings`) is responsible for persisting the hint to a
 * sidecar file before discarding it.
 */
export function migrateLegacySettings(
  parsed: Record<string, unknown>,
): Partial<SubcastSettings> & { _migrationHint?: LlmModelId } {
  const { ollamaModel, ...rest } = parsed;
  if (typeof ollamaModel === 'string') {
    const m = /^qwen2\.5:(3b|7b|14b)$/i.exec(ollamaModel);
    const hint = m ? (m[1]!.toLowerCase() as LlmModelId) : undefined;
    return { ...(rest as Partial<SubcastSettings>), _migrationHint: hint };
  }
  return rest as Partial<SubcastSettings>;
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
