import { getDb } from './db';

export interface SubcastSettings {
  whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  ollamaModel: string;
  cacheLimitGB: number;
  silenceThresholdMs: number;
  debugMode: boolean;
}

export const DEFAULT_SETTINGS: SubcastSettings = {
  whisperModel: 'base',
  ollamaModel: 'qwen2.5:7b',
  cacheLimitGB: 10,
  silenceThresholdMs: 10_000,
  debugMode: false,
};

const KEY = 'subcast.v1';

export function loadSettings(): SubcastSettings {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<SubcastSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
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
